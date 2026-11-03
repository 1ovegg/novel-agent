"""Expose older saved work without pretending it contains original model prompts."""

ARTIFACTS = {
    "topic_scout": ("topic_research", "mini_arc_outline"),
    "architect": ("bible",),
    "character_manager": ("characters", "character_creation_progress"),
    "plot_planner": ("outline", "chapter_plan"),
    "writer": ("chapter_draft", "previous_chapter_draft"),
    "refiner": ("polished_chapter", "previous_polished_chapter"),
    "memory_manager": ("memory",),
}


def saved_agent_work(fm, agent=None):
    try:
        saved = fm.load_workflow_state() or {}
    except (OSError, ValueError):
        saved = {}
    state = saved.get("state", {})
    entries = state.get("agent_log", [])
    if agent is None:
        activity = {}
        for entry in entries:
            item = activity.setdefault(entry["agent"], {"count": 0})
            item.update(count=item["count"] + 1, updated_at=entry.get("timestamp"))
        return activity
    logs = [entry for entry in entries if entry.get("agent") == agent]
    artifacts = {key: state[key] for key in ARTIFACTS.get(agent, ()) if state.get(key)}
    if not logs and not artifacts:
        return None
    return {
        "source": "workflow_state.json",
        "notice": "这是已保存的阶段成果与工作日志，不是每次模型调用的原始输出。旧版本没有保存完整输入和指令，无法补录。",
        "updated_at": saved.get("updated_at"),
        "logs": logs,
        "artifacts": artifacts,
    }
