"""Model scheduler — routes agent requests to the correct LLM model."""

import asyncio
import json
import logging
import re
from collections.abc import AsyncGenerator
from time import perf_counter, time_ns
from typing import Any

from pydantic import BaseModel, ValidationError

from ..config.model_assignments import ModelAssignment
from ..config.settings import Settings, get_settings
from .client import BaseLLMProvider, LLMResponse
from .providers import (
    AnthropicProvider,
    OpenAIProvider,
    _build_field_map,
    _coerce_field_types,
    _extract_json,
    _translate_keys,
)

logger = logging.getLogger(__name__)


def _validate_structured(response_model, content):
    try:
        return response_model.model_validate_json(content)
    except (ValidationError, ValueError):
        data = _try_parse_json(content)
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object, not a table, list or text")
        field_map = _build_field_map(response_model)
        if len(data) == 1:
            key = next(iter(data))
            if key not in response_model.model_fields and key not in field_map and isinstance(data[key], dict):
                data = data[key]
        return response_model.model_validate(_coerce_field_types(_translate_keys(data, field_map), response_model))


def _try_parse_json(raw: str) -> Any:
    """Attempt to parse JSON, fixing common LLM output issues.

    Returns the parsed object, or raises ValueError with details.
    """
    text = _extract_json(raw)

    # Attempt 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Attempt 2: escape literal newlines/tabs within JSON strings
    result_chars = []
    in_string = False
    escaped = False
    for ch in text:
        if escaped:
            result_chars.append(ch)
            escaped = False
            continue
        if ch == "\\":
            result_chars.append(ch)
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            result_chars.append(ch)
            continue
        if in_string:
            if ch == "\n":
                result_chars.append("\\n")
            elif ch == "\r":
                result_chars.append("\\r")
            elif ch == "\t":
                result_chars.append("\\t")
            else:
                result_chars.append(ch)
        else:
            result_chars.append(ch)
    fixed = "".join(result_chars)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # Attempt 2b: fix missing commas too
    fixed2 = re.sub(r'"\s*\n\s*"', '",\n"', fixed)
    fixed2 = re.sub(r'"\s+"', '", "', fixed2)
    try:
        return json.loads(fixed2)
    except json.JSONDecodeError:
        pass

    # Attempt 3: try to extract just the first complete JSON object
    stack = []
    start = None
    for i, ch in enumerate(text):
        if ch == "{":
            if not stack:
                start = i
            stack.append("{")
        elif ch == "}":
            if stack:
                stack.pop()
                if not stack and start is not None:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        continue
        elif ch == "[":
            stack.append("[")
        elif ch == "]":
            if stack:
                stack.pop()

    # Attempt 4: truncated JSON — try closing unclosed strings/objects/arrays
    # Track brace depth, bracket depth, and string state
    in_str = False
    escaped = False
    brace_count = 0
    bracket_count = 0
    for ch in text:
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"' and not escaped:
            in_str = not in_str
        if not in_str:
            if ch == "{":
                brace_count += 1
            elif ch == "}":
                brace_count -= 1
            elif ch == "[":
                bracket_count += 1
            elif ch == "]":
                bracket_count -= 1

    fixed = text.rstrip().rstrip(",")  # strip trailing commas too
    # If still inside a string, close it
    if in_str:
        fixed += '"'
    # Close structures inside-out: alternate braces/brackets,
    # starting with whichever type is innermost (has more opens)
    while brace_count > 0 or bracket_count > 0:
        if brace_count >= bracket_count and brace_count > 0:
            fixed += "}"
            brace_count -= 1
        elif bracket_count > 0:
            fixed += "]"
            bracket_count -= 1

    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # Attempt 5: try removing the last incomplete item (common with list truncation)
    # Find the last complete item before the truncation point
    if "[" in text:
        # Try closing at the last comma before an unclosed string
        last_comma = text.rfind(",")
        if last_comma > 0:
            truncated = text[:last_comma].rstrip()
            # Re-check brace/bracket balance on truncated text
            bc = truncated.count("{") - truncated.count("}")
            brc = truncated.count("[") - truncated.count("]")
            in_s = False
            esc = False
            for ch in truncated:
                if esc:
                    esc = False
                    continue
                if ch == "\\":
                    esc = True
                    continue
                if ch == '"':
                    in_s = not in_s
            if in_s:
                truncated += '"'
            # Inside-out closing
            while bc > 0 or brc > 0:
                if bc >= brc and bc > 0:
                    truncated += "}"
                    bc -= 1
                elif brc > 0:
                    truncated += "]"
                    brc -= 1
            try:
                return json.loads(truncated)
            except json.JSONDecodeError:
                pass

    raise ValueError(f"Cannot parse LLM JSON output (first 200 chars): {text[:200]}")


logger = logging.getLogger(__name__)


class ModelScheduler:
    """Routes agent generation requests to the configured LLM provider and model.

    Features:
    - Maps agent_type -> provider + model via ModelAssignment config
    - Primary/fallback model with automatic retry on failure
    - Per-agent token and cost tracking
    - Lazy provider initialization
    """

    def __init__(
        self,
        assignments: list[ModelAssignment] | None = None,
        settings: Settings | None = None,
    ):
        """
        Args:
            assignments: List of ModelAssignment configurations.
                If None, loads defaults from model_assignments.py.
            settings: Optional Settings instance (for tests / custom config).
                If None, uses the global get_settings() singleton.
        """
        if assignments is None:
            from ..config.model_assignments import get_default_assignments

            assignments = get_default_assignments()

        self._assignments: dict[str, ModelAssignment] = {a.agent_type: a for a in assignments}
        self._providers: dict[str, BaseLLMProvider] = {}
        self._usage_stats: dict[str, dict] = {
            agent_type: {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "errors": 0}
            for agent_type in self._assignments
        }
        self._settings = settings
        self._request_slots = asyncio.Semaphore((settings or get_settings()).llm_max_concurrent_requests)

    async def _generate_provider(self, provider, agent_type, **kwargs):
        from ..api.agent_trace import agent_traces

        queued = perf_counter()
        record = agent_traces.start(agent_type, kwargs.get("model"), kwargs.get("system_prompt", ""), kwargs.get("user_prompt", ""))
        try:
            async with self._request_slots:
                started = perf_counter()
                agent_traces.update(record, status="running", queue_seconds=round(started - queued, 2))
                response = await provider.generate(**kwargs)
                agent_traces.finish(record, "completed", queued, output=response.content, model=response.model,
                                    input_tokens=response.input_tokens, output_tokens=response.output_tokens,
                                    finish_reason=response.finish_reason)
                logger.info("%s 请求完成：%.1f秒，排队%.1f秒，输出%d token，结束原因%s",
                            agent_type, perf_counter() - started, started - queued,
                            response.output_tokens, response.finish_reason or "未知")
                return response
        except asyncio.CancelledError:
            agent_traces.finish(record, "interrupted", queued, error="调用已取消，进度已保留")
            raise
        except Exception as exc:
            agent_traces.finish(record, "failed", queued, error=str(exc))
            raise

    async def _stream_provider(self, provider, agent_type, **kwargs):
        from ..api.agent_trace import agent_traces

        started = perf_counter()
        record = agent_traces.start(agent_type, kwargs.get("model"), kwargs.get("system_prompt", ""), kwargs.get("user_prompt", ""), "running")
        chunks = []
        checkpoint = started
        try:
            async for token in provider.generate_stream(**kwargs):
                chunks.append(token)
                if perf_counter() - checkpoint >= 2:
                    agent_traces.update(record, output="".join(chunks))
                    checkpoint = perf_counter()
                yield token
            agent_traces.finish(record, "completed", started, output="".join(chunks))
        except (asyncio.CancelledError, GeneratorExit):
            agent_traces.finish(record, "interrupted", started, output="".join(chunks), error="流式调用已中断")
            raise
        except Exception as exc:
            agent_traces.finish(record, "failed", started, output="".join(chunks), error=str(exc))
            raise

    # ================================================================
    # Public API
    # ================================================================

    async def generate(
        self,
        agent_type: str,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel] | None = None,
        temperature_override: float | None = None,
        max_tokens_override: int | None = None,
    ) -> LLMResponse:
        """Generate a response using the model assigned to this agent type.

        Args:
            agent_type: Which agent is making the request (e.g. 'writer', 'editor').
            system_prompt: System-level instruction.
            user_prompt: Content to process.
            response_model: Optional Pydantic model for structured JSON output.
            temperature_override: Override the configured temperature.
            max_tokens_override: Override configured max tokens.

        Returns:
            LLMResponse with content and usage metadata.
        """
        assignment = self._get_assignment(agent_type)
        provider = self._get_provider(assignment.provider)

        temperature = temperature_override if temperature_override is not None else assignment.temperature
        max_tokens = max_tokens_override if max_tokens_override is not None else assignment.max_tokens

        try:
            response = await self._generate_provider(provider, agent_type,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=assignment.primary_model,
                temperature=temperature,
                max_tokens=max_tokens,
                response_format=response_model,
            )
            self._track_success(agent_type, response)
            return response

        except Exception as e:
            logger.warning(f"Primary model {assignment.primary_model} failed for {agent_type}: {e}")

            if assignment.fallback_model:
                logger.info(f"Retrying with fallback model {assignment.fallback_model}")
                try:
                    response = await self._generate_provider(provider, agent_type,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        model=assignment.fallback_model,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        response_format=response_model,
                    )
                    self._track_success(agent_type, response)
                    return response
                except Exception as fallback_error:
                    logger.error(f"Fallback model also failed for {agent_type}: {fallback_error}")
                    self._track_error(agent_type)
                    raise

            self._track_error(agent_type)
            raise

    async def generate_structured(
        self,
        agent_type: str,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        temperature_override: float | None = None,
        max_tokens_override: int | None = None,
    ) -> BaseModel:
        """Generate and parse a structured response.

        Shortcut that combines generate() with Pydantic model parsing.
        Includes fallback Chinese→English key translation for local models.
        """
        prompt = user_prompt
        budget = max_tokens_override
        for attempt in range(2):
            response = await self.generate(
                agent_type=agent_type, system_prompt=system_prompt, user_prompt=prompt,
                response_model=response_model,
                temperature_override=temperature_override if attempt == 0 else 0.1,
                max_tokens_override=budget,
            )
            try:
                if response.finish_reason in ("length", "max_tokens"):
                    raise ValueError("模型输出达到长度上限，被截断")
                return _validate_structured(response_model, response.content)
            except (ValidationError, ValueError) as exc:
                self._save_invalid_output(agent_type, response, exc)
                if attempt:
                    self._track_error(agent_type)
                    reason = (
                        f"模型输出达到长度上限（{response.output_tokens} token），正文被截断"
                        if response.finish_reason in ("length", "max_tokens")
                        else "返回的 JSON 格式不完整或字段不符合要求"
                    )
                    raise ValueError(f"{agent_type} {reason}；已重试一次，原始输出已保存到 diagnostics，可从当前步骤继续") from exc
                if response.finish_reason in ("length", "max_tokens"):
                    logger.warning("%s 回复达到输出上限被截断（%d token），正在提高预算并精简重试一次",
                                   agent_type, response.output_tokens)
                else:
                    logger.warning("%s 输出格式不符合要求，正在进行一次精简格式重试", agent_type)
                prompt = (
                    user_prompt + "\n\n上一次结果无法解析。请重新生成完整且精简的 JSON，不要从中间续写。"
                    "不使用表格、注释或解释，严格遵循字段结构。错误信息："
                    + str(exc)[:600] + "\n上次结果片段（仅作纠错参考）：\n" + response.content[:12000]
                )
                if response.finish_reason in ("length", "max_tokens"):
                    budget = min((budget or self._get_assignment(agent_type).max_tokens) * 2, 16384)

    def _save_invalid_output(self, agent_type, response, error):
        from ..api.runtime import project_context
        settings = self._settings or get_settings()
        project_id = project_context.get()
        root = settings.workspace_path
        if project_id:
            root = root / "projects" / re.sub(r"[^\w.-]", "_", project_id)
        payload = {
            "agent": agent_type, "model": response.model, "finish_reason": response.finish_reason,
            "output_tokens": response.output_tokens, "error": str(error), "content": response.content,
        }
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        for key in (settings.openai_api_key, settings.anthropic_api_key, settings.openrouter_api_key):
            if key:
                text = text.replace(key, "[REDACTED]")
        try:
            folder = root / "diagnostics"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"{agent_type}_{time_ns()}.json").write_text(text, encoding="utf-8")
        except OSError:
            logger.warning("无法保存模型格式错误诊断文件")

    async def generate_stream(
        self,
        agent_type: str,
        system_prompt: str,
        user_prompt: str,
        temperature_override: float | None = None,
        max_tokens_override: int | None = None,
    ) -> AsyncGenerator[str, None]:
        """Stream a text generation, yielding tokens as they arrive.

        Structured output (JSON mode) is NOT supported in streaming mode.
        """
        assignment = self._get_assignment(agent_type)
        provider = self._get_provider(assignment.provider)

        temperature = temperature_override if temperature_override is not None else assignment.temperature
        max_tokens = max_tokens_override if max_tokens_override is not None else assignment.max_tokens

        try:
            async for token in self._stream_provider(provider, agent_type,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=assignment.primary_model,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                yield token
        except Exception as e:
            logger.warning(f"Primary model stream failed for {agent_type}: {e}")
            if assignment.fallback_model:
                async for token in self._stream_provider(provider, agent_type,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    model=assignment.fallback_model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                ):
                    yield token
            else:
                raise

    def get_usage_stats(self) -> dict:
        """Get per-agent usage statistics."""
        return dict(self._usage_stats)

    def get_total_cost(self) -> float:
        """Get total estimated cost across all agents."""
        return round(sum(s["cost"] for s in self._usage_stats.values()), 6)

    def reset_stats(self) -> None:
        """Reset all usage statistics."""
        for stats in self._usage_stats.values():
            stats["calls"] = 0
            stats["input_tokens"] = 0
            stats["output_tokens"] = 0
            stats["cost"] = 0.0
            stats["errors"] = 0

    # ================================================================
    # Internal
    # ================================================================

    def _get_assignment(self, agent_type: str) -> ModelAssignment:
        """Get model assignment for an agent type. Falls back to 'orchestrator' if unknown."""
        if agent_type not in self._assignments:
            logger.warning(f"Unknown agent_type '{agent_type}', using orchestrator assignment")
            return self._assignments.get("orchestrator", list(self._assignments.values())[0])
        return self._assignments[agent_type]

    def _get_provider(self, provider_name: str) -> BaseLLMProvider:
        """Get or lazily initialize a provider instance."""
        if provider_name not in self._providers:
            self._providers[provider_name] = self._init_provider(provider_name)
        return self._providers[provider_name]

    def _init_provider(self, provider_name: str) -> BaseLLMProvider:
        """Initialize a provider instance based on name."""
        settings = self._settings if self._settings is not None else get_settings()

        if provider_name == "anthropic":
            if not settings.has_anthropic:
                raise ValueError("ANTHROPIC_API_KEY not configured")
            return AnthropicProvider(api_key=settings.anthropic_api_key)

        elif provider_name == "openai":
            if not settings.has_openai:
                raise ValueError("OPENAI_API_KEY not configured")
            kwargs = {"api_key": settings.openai_api_key, "trust_env": settings.openai_trust_env,
                      "thinking_enabled": settings.openai_thinking_enabled}
            if settings.openai_base_url:
                kwargs["base_url"] = settings.openai_base_url
            return OpenAIProvider(**kwargs)

        elif provider_name in ("modelscope", "dashscope"):
            # OpenAI-compatible providers — use the same API format
            if not settings.has_openai:
                raise ValueError(
                    f"OPENAI_API_KEY not configured for {provider_name}. Set OPENAI_API_KEY and OPENAI_BASE_URL in .env"
                )
            kwargs = {"api_key": settings.openai_api_key, "trust_env": settings.openai_trust_env,
                      "thinking_enabled": settings.openai_thinking_enabled}
            if settings.openai_base_url:
                kwargs["base_url"] = settings.openai_base_url
            return OpenAIProvider(**kwargs)

        elif provider_name == "openrouter":
            if not settings.has_openrouter:
                raise ValueError("OPENROUTER_API_KEY not configured")
            return OpenAIProvider(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
                trust_env=settings.openai_trust_env,
            )

        elif provider_name == "ollama":
            return OpenAIProvider(
                api_key="ollama",  # Not used but required by OpenAI client
                base_url=f"{settings.ollama_base_url}/v1",
                trust_env=settings.openai_trust_env,
            )

        else:
            raise ValueError(f"Unknown provider: {provider_name}")

    def _track_success(self, agent_type: str, response: LLMResponse) -> None:
        """Track successful API call."""
        stats = self._usage_stats.setdefault(
            agent_type,
            {
                "calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost": 0.0,
                "errors": 0,
            },
        )
        stats["calls"] += 1
        stats["input_tokens"] += response.input_tokens
        stats["output_tokens"] += response.output_tokens
        stats["cost"] += response.cost

    def _track_error(self, agent_type: str) -> None:
        """Track failed API call."""
        stats = self._usage_stats.setdefault(
            agent_type,
            {
                "calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost": 0.0,
                "errors": 0,
            },
        )
        stats["errors"] += 1
