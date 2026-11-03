"""Explicit recovery for projects affected by the legacy double chapter increment.

Call only after backing up the project. Existing prose and plans are never renamed
or rewritten; only phase markers, the resume checkpoint and derived memory change.
"""

import re

from ..graph.nodes import set_chapter_phase
from ..models.common import ProjectStatus, WorkflowPhase
from ..models.memory import MemoryState, ShortTermMemory
from ..models.state import MainState


def recover_chapter_sequence(fm) -> dict:
    record = fm.load_workflow_state()
    state = MainState.model_validate(record["state"])
    memory = state.memory or fm.load_memory() or MemoryState()
    numbers = set()
    for folder in (fm.root / "output" / "chapters", fm.root / "outline" / "chapters"):
        for path in folder.iterdir():
            match = re.match(r"chapter_(\d+)", path.name)
            if match:
                numbers.add(int(match[1]))
    finished = {number for number in numbers if fm.load_chapter_markdown(number)}
    prefix = 0
    while prefix + 1 in finished and prefix + 1 in memory.long_term.chapter_summaries:
        prefix += 1
    for number in numbers:
        phase = (5 if number <= prefix else 4) if number in finished else 1 if fm.load_chapter_plan(number) else 0
        set_chapter_phase(fm, number, phase)

    # Reconstruct only context from the consecutive completed prefix. Future saved
    # chapters will contribute memory when the loop reaches them, without rewriting.
    memory.long_term.chapter_summaries = {ch:text for ch,text in memory.long_term.chapter_summaries.items() if ch <= prefix}
    memory.long_term.facts = {}
    memory.character_states = {}
    for number in range(1,prefix + 1):
        draft = fm.load_chapter_draft(number)
        if not draft:
            continue
        for fact in draft.new_facts:
            fact.source_chapter = number
            memory.long_term.facts[fact.id] = fact
        for change in draft.character_state_changes:
            memory.character_states.setdefault(change.character_id,{})[change.attribute] = change.new_value
    memory.timeline = [event for event in memory.timeline if 0 < event.chapter <= prefix]
    memory.foreshadowing.entries = [entry for entry in memory.foreshadowing.entries if 0 < entry.planted_chapter <= prefix]
    for entry in memory.foreshadowing.entries:
        if entry.payoff_chapter and entry.payoff_chapter > prefix:
            entry.payoff_chapter, entry.status = None,"active"
    memory.long_term.stage_summaries = {}
    memory.long_term.arc_summaries = {}
    memory.long_term.global_summary = ""
    memory.long_term.consolidated_summary = ""
    memory.stage_boundaries = []
    memory.arc_boundaries = []
    memory.unresolved_issues = []
    memory.short_term = ShortTermMemory(
        current_chapter_summary=memory.long_term.chapter_summaries.get(prefix,""),
        previous_chapter_summary=memory.long_term.chapter_summaries.get(prefix-1,""),
        recent_character_states=memory.character_states,
        active_foreshadowing=[entry.id for entry in memory.foreshadowing.active],
    )
    state.memory = memory
    state.characters = fm.load_characters() or state.characters
    state.current_chapter_number = prefix
    state.previous_chapter_plan = fm.load_chapter_plan(prefix) if prefix else None
    state.previous_chapter_draft = fm.load_chapter_draft(prefix) if prefix else None
    state.previous_polished_chapter = None
    state.chapter_plan = state.chapter_draft = state.review_report = state.polished_chapter = None
    state.writing_progress = {}
    state.polish_progress = {}
    state.review_iteration = 0
    state.current_phase = WorkflowPhase.CHAPTER_PLANNING
    state.project_meta = fm.load_project_meta() or state.project_meta
    if state.project_meta:
        state.project_meta.current_chapter = prefix
        state.project_meta.current_phase = WorkflowPhase.CHAPTER_PLANNING
        state.project_meta.status = ProjectStatus.PAUSED
        fm.save_project_meta(state.project_meta)
    fm.save_memory(memory)
    fm.save_workflow_state(state,"paused","chapter_planning")
    return {"preserved_chapters":sorted(finished),"completed_prefix":prefix,"next_chapter":prefix+1}
