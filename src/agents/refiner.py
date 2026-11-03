"""Refiner Agent — polishes chapter drafts based on review feedback."""

import hashlib
import json
import logging
import re
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, Field

from ..models.bible import NovelBible
from ..models.chapter import ChapterDraft, PolishedChapter
from ..models.review import ReviewReport
from .base import BaseAgent

logger = logging.getLogger(__name__)


class PolishedOutput(BaseModel):
    """LLM output for polished chapter."""

    title: str = Field(default="")
    content: str = Field(..., description="润色后的章节正文")
    revision_notes: str = Field(default="", description="修改说明")


def _split_passages(content: str, limit: int = 900) -> list[str]:
    """Keep every source character, preferring paragraph and sentence boundaries."""
    chunks = []
    while content:
        end = min(limit, len(content))
        if end < len(content):
            boundaries = list(re.finditer(r"\n|[。！？]", content[:end]))
            candidates = [match.end() for match in boundaries if match.end() >= limit // 2]
            if candidates:
                end = candidates[-1]
        chunks.append(content[:end])
        content = content[end:]
    return chunks


class RefinerAgent(BaseAgent):
    """Polishes and revises chapter drafts.

    Handles:
    - Language rhythm and flow improvements
    - Duplicate sentence pattern removal
    - Cliché expression elimination
    - Dialogue naturalization
    - Chapter-end hook strengthening
    - AI-flavor removal
    """

    agent_type = "refiner"

    async def polish_chapter(
        self,
        draft: ChapterDraft,
        review: ReviewReport,
        bible: NovelBible,
        human_feedback: str | None = None,
        progress: dict | None = None,
        checkpoint: Callable[[str], Awaitable[None]] | None = None,
    ) -> PolishedChapter:
        """Polish a chapter draft based on review feedback.

        Args:
            draft: The chapter draft to polish.
            review: Review report with issues and suggestions.
            bible: Novel bible with style contract.
            human_feedback: Optional additional feedback from the human author.

        Returns:
            PolishedChapter with the refined content.
        """
        logger.info(f"Polishing chapter {draft.chapter_number}...")

        style = bible.style_contract

        # Compile issues into actionable feedback
        issues_text = self._format_issues(review)
        suggestions_text = "\n".join(f"- {s}" for s in review.suggestions)

        system_default = self.build_system_prompt(
            role="文字打磨师",
            expertise="你是一位追求极致的文字编辑。你能让一段普通的文字变得精准、有力、"
            "有韵味。你擅长调整句式节奏、删除冗余、增强画面感、让对话更自然。"
            "你对AI生成的套路表达有天然的敏感。",
            constraints=f"""文风要求：
- 语调：{style.tone}
- 句式风格：{style.sentence_style}
- 禁用表达：{style.forbidden_phrases}
- 推荐技法：{style.preferred_techniques}""",
        )
        user_default = f"""请对以下章节进行润色和修改：

【审阅报告】
总分：{review.overall_score}/10
各维度：{review.dimension_scores}

【需要修改的问题】
{issues_text}

【改进建议】
{suggestions_text}

【原文章节标题】{draft.title}

【原文章节正文】
{draft.content}

修改重点：
1. **句式变化**：消除重复句式，调整长短句比例
2. **删AI味**：删除「综上所述」「值得注意的是」「在...的过程中」等机械表达
3. **对话优化**：让每句对话更符合角色性格，删除过于功能化的台词
4. **画面感**：增强关键场景的感官细节（视觉、听觉、触觉）
5. **章末钩子**：确保结尾有足够的吸引力
6. **节奏**：调整场景推进速度，避免均分笔墨"""

        if human_feedback:
            user_default += f"\n\n【作者反馈】\n{human_feedback}"

        system, user = self.render_prompts(
            "polish_chapter",
            system_default=system_default,
            user_default=user_default,
            tone=style.tone,
            sentence_style=style.sentence_style,
            forbidden_phrases=", ".join(style.forbidden_phrases) if style.forbidden_phrases else "无",
            preferred_techniques=", ".join(style.preferred_techniques) if style.preferred_techniques else "无",
            overall_score=review.overall_score,
            dimension_scores=str(review.dimension_scores),
            issues_text=issues_text,
            suggestions_text=suggestions_text,
            draft_title=draft.title,
            draft_content=draft.content,
            human_feedback=human_feedback,
        )

        progress = progress if progress is not None else {}
        chunk_size = progress.get("chunk_size", 900 if progress.get("parts") else 1200)
        passages = _split_passages(draft.content, limit=chunk_size)
        if not passages or not draft.content.strip():
            raise ValueError("章节初稿为空，无法润色")
        # Include feedback/style in the key so edits invalidate obsolete partial work.
        fingerprint = hashlib.sha256(json.dumps(
            [draft.chapter_number, system, user, passages], ensure_ascii=False,
        ).encode("utf-8")).hexdigest()
        if progress.get("fingerprint") != fingerprint:
            progress.clear()
            progress.update(fingerprint=fingerprint, parts=[], total=len(passages), chunk_size=chunk_size)
        parts = progress["parts"]
        for index in range(len(parts), len(passages)):
            if checkpoint:
                await checkpoint(f"第{draft.chapter_number}章润色 {index + 1}/{len(passages)} 段，已保存 {len(parts)} 段")
            # The template's full draft is context only; the output covers this passage.
            nearby = (
                "【前段参考】" + (passages[index-1][-250:] if index else "本章开头")
                + "\n【本段原文】" + passages[index]
                + "\n【后段参考】" + (passages[index+1][:250] if index+1<len(passages) else "本章结尾")
            )
            section_prompt = (
                user.replace(draft.content, nearby) + f"\n\n【本次分段润色：{index + 1}/{len(passages)}】\n"
                "上下相邻段落仅作衔接参考。本次只修改下方指定原文，不要输出整章、分析过程或新增情节。"
                "保持人物、事件顺序和段落衔接，正文长度控制在指定原文的80%至120%。"
                "title沿用原标题，revision_notes不超过50字。只有最后一段可以调整章末钩子。\n"
                f"【本次指定原文开始】\n{passages[index]}\n【本次指定原文结束】"
            )
            part = await self.generate_structured(
                system_prompt=system, user_prompt=section_prompt, response_model=PolishedOutput,
                temperature_override=0.4, max_tokens_override=8192,
            )
            if not part.content.strip():
                raise ValueError(f"第{index + 1}段润色正文为空，已保存此前段落，可继续重试")
            parts.append(part.model_dump())
            if checkpoint:
                await checkpoint(f"第{draft.chapter_number}章润色已保存 {len(parts)}/{len(passages)} 段")
        result = PolishedOutput(
            title=draft.title,
            content="\n\n".join(part["content"].strip() for part in parts),
            revision_notes="\n".join(part["revision_notes"] for part in parts if part["revision_notes"]),
        )

        word_count = len(result.content.replace(" ", "").replace("\n", ""))

        polished = PolishedChapter(
            chapter_number=draft.chapter_number,
            title=result.title or draft.title,
            content=result.content,
            word_count=word_count,
            revision_notes=result.revision_notes,
        )

        logger.info(f"Chapter {draft.chapter_number} polished: {word_count} chars")
        return polished

    def _format_issues(self, review: ReviewReport) -> str:
        """Format review issues for the polish prompt."""
        if not review.issues:
            return "（无特定问题）"

        by_severity = {"critical": [], "major": [], "minor": [], "suggestion": []}
        for issue in review.issues:
            sev = issue.severity if isinstance(issue.severity, str) else issue.severity.value
            by_severity.setdefault(sev, []).append(issue)

        lines = []
        for sev in ["critical", "major", "minor", "suggestion"]:
            items = by_severity.get(sev, [])
            if items:
                lines.append(f"\n### {sev.upper()} ({len(items)}个)")
                for item in items:
                    lines.append(f"- [{item.category}] {item.description}")
                    if item.suggestion:
                        lines.append(f"  建议: {item.suggestion}")

        return "\n".join(lines)
