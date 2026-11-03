"""Project-scoped model call telemetry. Full payloads are fetched on demand."""

import json
import re
from time import perf_counter, time_ns
from uuid import uuid4

from .runtime import execution_context, now_iso, project_context, runtime_status


def _safe_text(value):
    from ..config.settings import get_settings

    text = str(value)
    settings = get_settings()
    for key in (settings.openai_api_key, settings.anthropic_api_key, settings.openrouter_api_key):
        if key:
            text = text.replace(key, "[REDACTED]")
    return re.sub(r"(?i)Bearer\s+[^\s'\"<>]+", "Bearer [REDACTED]", text)


class AgentTraceStore:
    def __init__(self):
        self.active = {}
        self.cache = {}

    def folder(self, project_id):
        path = runtime_status.project_files.get(project_id)
        return path.parent / "agent_calls" if path else None

    def _save(self, record):
        folder = self.folder(record["project_id"])
        if not folder:
            return
        try:
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / (record["id"] + ".json")
            temp = target.with_suffix(".tmp")
            temp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            temp.replace(target)
            summary = {k: v for k, v in record.items() if k not in ("instruction", "input", "output")}
            with (folder / "index.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(summary, ensure_ascii=False) + "\n")
        except OSError:
            # Observability must never interrupt generation.
            pass

    def start(self, agent, model, instruction, input_text, status="queued"):
        project_id = project_context.get()
        if not project_id or not self.folder(project_id):
            return None
        record = {
            "id": uuid4().hex, "project_id": project_id, "agent": agent, "model": model,
            "session": runtime_status.session_id, "phase": runtime_status.projects.get(project_id, {}).get("phase"),
            "started_at": now_iso(), "updated_at": now_iso(), "status": status,
            "order": time_ns(),
            "instruction": _safe_text(instruction), "input": _safe_text(input_text), "output": "",
            **(execution_context.get() or {}),
        }
        self.active[record["id"]] = record
        self._save(record)
        return record

    def update(self, record, **fields):
        if record is None:
            return
        fields = {k: _safe_text(v) if isinstance(v, str) else v for k, v in fields.items()}
        record.update(fields, updated_at=now_iso())
        self._save(record)

    def finish(self, record, status, started, **fields):
        if record is None:
            return
        fields = {k: _safe_text(v) if isinstance(v, str) else v for k, v in fields.items()}
        self.update(record, status=status, elapsed_seconds=round(perf_counter() - started, 2), **fields)
        self.active.pop(record["id"], None)

    def _recovered(self, record):
        if record.get("status") in ("queued", "running") and record["id"] not in self.active:
            return {**record, "status": "interrupted", "error": "服务重启或调用中断，未记录最终结果"}
        return record

    def summaries(self, project_id, agent=None, limit=200):
        folder = self.folder(project_id)
        records = {}
        if folder and (folder / "index.jsonl").exists():
            try:
                path = folder / "index.jsonl"
                stamp = path.stat().st_mtime_ns
                cached = self.cache.get(project_id)
                if cached and cached[0] == stamp:
                    records = dict(cached[1])
                else:
                    with path.open(encoding="utf-8") as stream:
                        for line in stream:
                            try:
                                record = json.loads(line)
                                records[record["id"]] = self._recovered(record)
                            except (ValueError, KeyError):
                                continue
                    self.cache[project_id] = (stamp, dict(records))
            except OSError:
                pass
        for record in self.active.values():
            if record["project_id"] == project_id:
                records[record["id"]] = {k: v for k, v in record.items() if k not in ("instruction", "input", "output")}
        result = sorted((r for r in records.values() if not agent or r["agent"] == agent), key=lambda r: r.get("order", 0))
        return result[-limit:] if limit else result

    def activity(self, project_id):
        result = {}
        for record in self.summaries(project_id, limit=None):
            item = result.setdefault(record["agent"], {"count": 0})
            item["count"] += 1
            item["latest"] = record
        return result

    def detail(self, project_id, call_id):
        folder = self.folder(project_id)
        if not folder or not re.fullmatch(r"[a-f0-9]{32}", call_id):
            return None
        try:
            return self._recovered(json.loads((folder / (call_id + ".json")).read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return None


agent_traces = AgentTraceStore()
