"""Bounded, pollable task status independent of WebSocket connections."""

import json
import logging
import re
from collections import deque
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from uuid import uuid4

project_context: ContextVar[str | None] = ContextVar("project_context", default=None)
execution_context: ContextVar[dict | None] = ContextVar("execution_context", default=None)


def now_iso():
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


def redact(message):
    from ..config.settings import get_settings

    text = str(message)
    settings = get_settings()
    for key in (settings.openai_api_key, settings.anthropic_api_key, settings.openrouter_api_key):
        if key:
            text = text.replace(key, "[REDACTED]")
    return re.sub(r"(?i)Bearer\s+[^\s'\"<>]+", "Bearer [REDACTED]", text)[:1600]


class RuntimeStatus:
    def __init__(self):
        self.events = deque(maxlen=400)
        self.projects = {}
        self.sequence = 0
        self.session_id = uuid4().hex[:8]
        self.project_files = {}
        self.disk_events = {}

    def bind_project(self, project_id, fm):
        if fm.root.exists() and fm.root.resolve().is_relative_to((fm.workspace_root / "projects").resolve()):
            self.project_files[project_id] = fm.root / "runtime_events.jsonl"

    def _read_events(self, project_id):
        path = self.project_files.get(project_id)
        if not path or not path.exists():
            return []
        try:
            stamp = path.stat().st_mtime_ns
            cached = self.disk_events.get(project_id)
            if cached and cached[0] == stamp:
                return cached[1]
            events = []
            for line in path.read_text(encoding="utf-8").splitlines()[-80:]:
                try:
                    events.append(json.loads(line))
                except ValueError:
                    continue
            self.disk_events[project_id] = (stamp, events)
            return events
        except OSError:
            return []

    def log(self, message, level="info", project_id=None, phase=None):
        self.sequence += 1
        event = {
            "id": f"{self.session_id}:{self.sequence}", "time": now_iso(), "level": level,
            "message": redact(message), "project_id": project_id, "phase": phase,
        }
        self.events.append(event)
        path = self.project_files.get(project_id)
        if path:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(event, ensure_ascii=False) + "\n")
            except OSError:
                pass

    def observe(self, project_id, event):
        kind = event.get("type")
        if kind == "agent_message":
            self.projects.setdefault(project_id, {})["detail"] = redact(event.get("content", ""))
            self.log(event.get("content", ""), project_id=project_id)
            return
        if kind not in {"phase_update", "phase_complete", "phase_blocked", "error", "workflow_complete", "topic_editing", "workflow_paused", "workflow_resumed"}:
            return
        state = self.projects.setdefault(project_id, {"status": "idle"})
        phase = event.get("phase") or state.get("phase", "idle")
        if phase == "workflow":
            phase = state.get("phase", "workflow")
        statuses = {
            "phase_update": "running", "phase_complete": "waiting",
            "phase_blocked": "waiting", "error": "failed", "workflow_complete": "completed",
            "topic_editing": "editing",
            "workflow_paused": "paused", "workflow_resumed": "running",
        }
        message = event.get("error") or event.get("message") or {
            "phase_complete": "阶段完成", "phase_blocked": "等待你的确认", "workflow_complete": "创作已完成",
        }.get(kind, "正在执行")
        changed = state.get("message") != message or state.get("phase") != phase or state.get("status") != statuses[kind]
        if state.get("phase") != phase or (statuses[kind] == "running" and state.get("status") != "running"):
            state["started_at"] = now_iso()
            state.pop("detail", None)
        state.update(status=statuses[kind], phase=phase, message=redact(message), updated_at=now_iso())
        if kind == "error":
            state["error"] = redact(message)
        elif kind in ("phase_update", "topic_editing"):
            state.pop("error", None)
        if changed:
            self.log(message, "error" if kind == "error" else "info", project_id, phase)

    def snapshot(self, project_id=None):
        events = [*self._read_events(project_id), *[e for e in self.events if e["project_id"] == project_id]]
        unique = {str(event["id"]): event for event in events}
        return {
            "server_time": now_iso(),
            "project": self.projects.get(project_id, {"status": "idle", "message": "尚未启动任务"}),
            "events": sorted(unique.values(), key=lambda event: event["time"])[-60:],
        }


runtime_status = RuntimeStatus()


class RuntimeLogHandler(logging.Handler):
    def emit(self, record):
        if record.name.startswith("src."):
            try:
                runtime_status.log(record.getMessage(), record.levelname.lower(), project_context.get())
            except Exception:
                pass
