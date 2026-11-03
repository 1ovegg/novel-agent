"""LangGraph node functions — the real runtime implementation of each phase.

Every workflow phase is a node (or a node pair: work + human confirmation):

- Work nodes run the phase executors from ``api/phase_executor``, persist
  artifacts to disk, and broadcast progress over WebSocket.
- Confirmation nodes pause for human approval via LangGraph's ``interrupt()``.
  The API layer catches ``GraphInterrupt``, broadcasts ``phase_blocked``, and
  resumes the graph with ``Command(resume=...)`` when the user confirms.

The run context — project_id, file manager, scheduler and orchestrator — is
passed through ``config["configurable"]`` (see ``graph/workflow.py``). This
replaces the previous imperative ``_run_phased_workflow`` loop in routes.py.
"""

import asyncio
import json
import logging
import os
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.types import interrupt

from ..models.common import WorkflowPhase
from ..models.state import MainState

logger = logging.getLogger(__name__)


# ============================================================
# Run-context helpers
# ============================================================


def _ctx(config: RunnableConfig | None) -> dict:
    """Extract the run context dict from the LangGraph config."""
    return (config or {}).get("configurable", {})


def _ws(config: RunnableConfig | None):
    from ..api.websocket import ws_manager

    return ws_manager


# ============================================================
# Disk-based chapter phase tracking (0=not started … 5=done)
# ============================================================


def get_chapter_phase(fm, ch: int) -> int:
    """Verify phase markers against artifacts so stale markers cannot skip a chapter."""
    phase_file = os.path.join(fm.root, "output", "chapters", f"chapter_{ch:03d}_phase.json")
    saved_phase = None
    try:
        if os.path.exists(phase_file):
            with open(phase_file) as f:
                saved_phase = json.load(f).get("phase", 0)
    except Exception:
        pass
    if fm.load_chapter_markdown(ch):
        return 5 if saved_phase == 5 else 4
    # A saved raw draft can still be waiting for fact extraction.
    if saved_phase == 1 and fm.load_chapter_plan(ch):
        return 1
    if getattr(fm, "load_review_report", None) and fm.load_review_report(ch):
        return 3
    if getattr(fm, "load_chapter_draft", None) and fm.load_chapter_draft(ch):
        return 2
    if fm.load_chapter_plan(ch):
        return 1
    return 0


def set_chapter_phase(fm, ch: int, phase: int) -> None:
    """Persist the chapter completion phase to disk."""
    phase_dir = os.path.join(fm.root, "output", "chapters")
    os.makedirs(phase_dir, exist_ok=True)
    with open(os.path.join(phase_dir, f"chapter_{ch:03d}_phase.json"), "w") as f:
        json.dump({"chapter": ch, "phase": phase}, f)


def apply_inspiration(state: MainState, resume: Any) -> MainState:
    """Apply user inspiration from an interrupt resume payload to state."""
    if isinstance(resume, dict):
        inspiration = resume.get("inspiration")
        if inspiration:
            state.current_inspiration = inspiration
        selected = resume.get("selected_topic")
        if selected and state.topic_research:
            from ..models.topic import TitleSynopsisReport
            state.topic_research.title_synopsis = [TitleSynopsisReport.model_validate(selected)]
    return state


def chapter_progress_increment(state: MainState) -> float:
    """Per-chapter progress increment, mirroring the original 5%→90% scheme."""
    total = state.project_config.target_chapter_count if state.project_config and state.project_config.target_chapter_count else max((state.outline.chapter_count if state.outline else 0), state.total_chapters, 3)
    return 85.0 / max(total, 1)


# ============================================================
# Shared phase runner (heartbeat + completion broadcasts)
# ============================================================


async def _run_phase(state: MainState, config: dict, phase: str, executor_fn) -> MainState:
    """Run one phase executor with heartbeat + completion broadcasts.

    Mirrors the previous ``routes._run_single_phase`` behaviour so the
    frontend sees identical progress events.
    """
    cfg = _ctx(config)
    project_id = cfg.get("project_id")
    fm = cfg.get("fm")
    orchestrator = cfg.get("orchestrator")
    ws = _ws(config)

    from ..api.phase_executor import PHASE_LABELS, get_phase_data
    from ..api.runtime import execution_context, project_context, runtime_status

    label = PHASE_LABELS.get(phase, phase)
    heartbeat_stop = asyncio.Event()

    async def _heartbeat():
        dots = 0
        while not heartbeat_stop.is_set():
            dots = (dots + 1) % 4
            await ws.broadcast_phase_update(
                project_id, phase, 0.15 + (dots * 0.02), f"正在{label}"
            )
            try:
                await asyncio.wait_for(heartbeat_stop.wait(), timeout=3)
            except TimeoutError:
                pass

    heartbeat_task = asyncio.create_task(_heartbeat())
    await ws.broadcast_phase_update(project_id, phase, 0.1, f"正在{label}...")

    context_token = project_context.set(project_id)
    if fm:
        runtime_status.bind_project(project_id, fm)
    execution_token = execution_context.set({"phase": phase, "chapter": state.current_chapter_number + 1 if phase in ("chapter_planning", "chapter_writing", "quality_review", "polish_revision", "memory_update") else None})
    if phase in ("topic_selection", "mini_arc_outline"):
        async def topic_checkpoint(partial, message):
            if fm:
                if partial.topic_research:
                    fm.save_topic_research(partial.topic_research)
                fm.save_workflow_state(partial,"running",phase)
            await ws.broadcast_agent_message(project_id,"topic_scout",message)
        orchestrator.topic_checkpoint = topic_checkpoint
    if phase == "character_creation":
        async def character_checkpoint(partial, message):
            if fm:
                fm.save_characters(partial.characters)
                fm.save_workflow_state(partial, "running", phase)
            await ws.broadcast_agent_message(project_id, "character_manager", message)
        orchestrator.character_checkpoint = character_checkpoint
    if phase == "polish_revision":
        async def polish_checkpoint(partial, message):
            if fm:
                fm.save_workflow_state(partial, "running", phase)
            await ws.broadcast_agent_message(project_id, "refiner", message)
        orchestrator.polish_checkpoint = polish_checkpoint
    if phase == "chapter_writing":
        async def writer_checkpoint(partial, message):
            if fm:
                if partial.chapter_draft:
                    fm.save_chapter_draft(partial.chapter_draft)
                fm.save_workflow_state(partial, "running", phase)
            await ws.broadcast_agent_message(project_id, "writer", message)
        orchestrator.writer_checkpoint = writer_checkpoint
    if fm:
        fm.save_workflow_state(state, "running", phase)
    try:
        updated = await executor_fn(state, orchestrator, fm)
    except asyncio.CancelledError:
        if fm:
            fm.save_workflow_state(state, "interrupted", phase)
        raise
    except Exception as exc:
        state.add_error(f"{phase}: {exc}")
        if fm:
            fm.save_workflow_state(state, "failed", phase, error=str(exc))
        raise
    finally:
        project_context.reset(context_token)
        execution_context.reset(execution_token)
        heartbeat_stop.set()
        heartbeat_task.cancel()

    if fm:
        fm.save_workflow_state(updated, "running", phase)
    phase_data = get_phase_data(updated, phase)
    await ws.broadcast_phase_update(project_id, phase, 1.0, f"{label}完成")
    await ws.broadcast_phase_complete(project_id, phase, phase_data)
    return updated


def _make_confirm_node(phase: str):
    """Create a human-confirmation node for a phase, using interrupt()."""

    async def confirm_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
        cfg = _ctx(config)
        project_id = cfg.get("project_id")
        # First invocation raises GraphInterrupt (caught by the API layer,
        # which broadcasts phase_blocked). On resume, returns the payload.
        resume = interrupt({"phase": phase, "action": "confirm"})
        state = apply_inspiration(state, resume)
        logger.info("Human confirmed phase %s for project %s", phase, project_id)
        return state.model_dump()

    return confirm_node


def _make_skip_node(phase: str):
    """Create a node that broadcasts 'already exists, skipping' for a phase."""

    async def skip_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
        cfg = _ctx(config)
        project_id = cfg.get("project_id")
        ws = _ws(config)

        from ..api.phase_executor import PHASE_LABELS, get_phase_data

        label = PHASE_LABELS.get(phase, phase)
        await ws.broadcast_phase_update(project_id, phase, 1.0, f"{label}已存在，跳过")
        await ws.broadcast_phase_complete(project_id, phase, get_phase_data(state, phase))
        return state.model_dump()

    return skip_node


# ============================================================
# Top-level phase nodes
# ============================================================


async def project_init_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Phase 1: Initialize project structure and metadata."""
    logger.info("Node: project_init")
    state.current_phase = WorkflowPhase.PROJECT_INIT
    return state.model_dump()


async def platform_scan_work_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Phase 0a: Platform scanning (consumes pending scan data)."""
    from ..api.phase_executor import execute_phase_platform_scan

    state = await _run_phase(state, config, "platform_scan", execute_phase_platform_scan)
    return state.model_dump()


async def topic_selection_work_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Phase 0b: Topic selection."""
    from ..api.phase_executor import execute_phase_topic_selection

    state = await _run_phase(state, config, "topic_selection", execute_phase_topic_selection)
    return state.model_dump()


async def mini_arc_work_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Phase 0c: Mini-arc outline."""
    from ..api.phase_executor import execute_phase_mini_arc

    state = await _run_phase(state, config, "mini_arc_outline", execute_phase_mini_arc)
    return state.model_dump()


async def bible_work_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Phase 1: Build the world bible."""
    from ..api.phase_executor import execute_phase_bible

    state = await _run_phase(state, config, "bible_construction", execute_phase_bible)
    return state.model_dump()


async def characters_work_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Phase 2: Create characters."""
    from ..api.phase_executor import execute_phase_characters

    state = await _run_phase(state, config, "character_creation", execute_phase_characters)
    return state.model_dump()


async def outline_work_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Phase 3: Create the master outline."""
    from ..api.phase_executor import execute_phase_outline

    state = await _run_phase(state, config, "master_outline", execute_phase_outline)
    return state.model_dump()


# ============================================================
# Chapter-loop nodes
# ============================================================


async def chapter_plan_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Plan the next chapter (skips when already planned, unless replanning)."""
    cfg = _ctx(config)
    fm = cfg.get("fm")
    ch = state.current_chapter_number + 1
    phase = get_chapter_phase(fm, ch)

    if phase < 1 or state.review_iteration > 0:
        from ..api.phase_executor import execute_phase_chapter_planning

        orchestrator = cfg.get("orchestrator")
        orchestrator.chapter_followup_context = fm.load_chapter_markdown(ch + 1) if fm else None
        state = await _run_phase(state, config, "chapter_planning", execute_phase_chapter_planning)
        if state.chapter_plan:
            fm.save_chapter_plan(state.chapter_plan)
        set_chapter_phase(fm, ch, 1)
    elif state.chapter_plan is None or state.chapter_plan.chapter_number != ch:
        # Resumed mid-chapter: restore the saved plan from disk
        plan = fm.load_chapter_plan(ch)
        if plan:
            state.chapter_plan = plan
    return state.model_dump()


async def chapter_write_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Write the chapter draft (re-writes on the revise loop)."""
    cfg = _ctx(config)
    fm = cfg.get("fm")
    ws = _ws(config)
    ch = state.current_chapter_number + 1
    phase = get_chapter_phase(fm, ch)

    if phase < 2 or state.review_iteration > 0:
        project_id = cfg.get("project_id")
        base_progress = 5 + (state.current_chapter_number * chapter_progress_increment(state))
        await ws.broadcast_phase_update(
            project_id, "chapter_writing", (base_progress + 4) / 100, f"正在写作第{ch}章..."
        )
        from ..api.phase_executor import execute_phase_chapter_writing

        async def execute(state, orchestrator, fm):
            return await execute_phase_chapter_writing(state, orchestrator, fm, ws, project_id)

        state = await _run_phase(state, config, "chapter_writing", execute)
        if state.chapter_draft:
            fm.save_chapter_draft(state.chapter_draft)
        set_chapter_phase(fm, ch, 2)
    elif state.chapter_draft is None or state.chapter_draft.chapter_number != ch:
        state.chapter_draft = fm.load_chapter_draft(ch)
    return state.model_dump()


async def chapter_review_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Run quality review (re-runs on the revise/rewrite loop)."""
    cfg = _ctx(config)
    fm = cfg.get("fm")
    ws = _ws(config)
    ch = state.current_chapter_number + 1
    phase = get_chapter_phase(fm, ch)

    if phase < 3 or state.review_iteration > 0:
        from ..api.phase_executor import execute_phase_review

        project_id = cfg.get("project_id")
        if state.chapter_draft is None:
            state.chapter_draft = fm.load_chapter_draft(ch)
        state = await _run_phase(state, config, "quality_review", execute_phase_review)
        if state.review_report:
            fm.save_review_report(state.review_report)
            await ws.broadcast_chapter_complete(project_id, ch, state.review_report.dimension_scores)
        set_chapter_phase(fm, ch, 3)
    elif state.review_report is None or state.review_report.chapter_number != ch:
        state.review_report = fm.load_review_report(ch)
    return state.model_dump()


async def chapter_polish_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Polish the chapter (applies review feedback)."""
    cfg = _ctx(config)
    fm = cfg.get("fm")
    ws = _ws(config)
    ch = state.current_chapter_number + 1
    phase = get_chapter_phase(fm, ch)

    if phase < 4:
        from ..api.phase_executor import execute_phase_polish

        project_id = cfg.get("project_id")
        base_progress = 5 + (state.current_chapter_number * chapter_progress_increment(state))
        await ws.broadcast_phase_update(
            project_id, "polish_revision", (base_progress + 8) / 100, f"润色第{ch}章..."
        )
        if state.chapter_draft is None:
            state.chapter_draft = fm.load_chapter_draft(ch)
        if state.review_report is None:
            state.review_report = fm.load_review_report(ch)
        state = await _run_phase(state, config, "polish_revision", execute_phase_polish)
        if state.polished_chapter:
            fm.save_chapter_markdown(state.polished_chapter)
        set_chapter_phase(fm, ch, 4)
    return state.model_dump()


async def chapter_memory_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Update memory after the chapter is polished."""
    cfg = _ctx(config)
    fm = cfg.get("fm")
    ch = state.current_chapter_number + 1
    phase = get_chapter_phase(fm, ch)

    if phase < 5:
        from ..api.phase_executor import execute_phase_memory

        if state.polished_chapter is None:
            from ..models.chapter import PolishedChapter
            from ..storage.serializers import MarkdownSerializer

            md_path = fm.root / "output" / "chapters" / f"chapter_{ch:03d}.md"
            if md_path.exists():
                _, md_title, md_content = MarkdownSerializer.load_chapter_markdown(md_path)
                state.polished_chapter = PolishedChapter(
                    chapter_number=ch,
                    title=md_title,
                    content=md_content,
                    word_count=len(md_content),
                )
        if state.chapter_draft is None:
            state.chapter_draft = fm.load_chapter_draft(ch)
        state = await _run_phase(state, config, "memory_update", execute_phase_memory)
        if state.memory:
            fm.save_memory(state.memory)
        set_chapter_phase(fm, ch, 5)
    return state.model_dump()


async def chapter_advance_node(state: MainState, config: RunnableConfig | None = None) -> dict[str, Any]:
    """Advance to the next chapter: reset per-chapter state, broadcast progress."""
    cfg = _ctx(config)
    project_id = cfg.get("project_id")
    ws = _ws(config)
    ch = state.current_chapter_number + 1
    base_progress = 5 + (state.current_chapter_number * chapter_progress_increment(state))

    state.advance_chapter()
    fm = cfg.get("fm")
    if fm:
        fm.save_workflow_state(state, "running", "chapter_planning")
    await ws.broadcast_phase_update(
        project_id, "chapter_loop", (base_progress + 16) / 100, f"第{ch}章完成 ✓"
    )
    return state.model_dump()


# ============================================================
# Confirmation nodes (LangGraph interrupt-based HITL)
# ============================================================

platform_scan_confirm_node = _make_confirm_node("platform_scan")
topic_selection_confirm_node = _make_confirm_node("topic_selection")
mini_arc_confirm_node = _make_confirm_node("mini_arc_outline")
bible_confirm_node = _make_confirm_node("bible_construction")
characters_confirm_node = _make_confirm_node("character_creation")
outline_confirm_node = _make_confirm_node("master_outline")

# Skip nodes (broadcast 'already exists, skipping')
platform_scan_skip_node = _make_skip_node("platform_scan")
bible_skip_node = _make_skip_node("bible_construction")
characters_skip_node = _make_skip_node("character_creation")
outline_skip_node = _make_skip_node("master_outline")
