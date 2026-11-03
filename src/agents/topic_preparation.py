"""Small resumable topic cards and bounded chapter beats for short fiction."""

import hashlib
import json

from pydantic import BaseModel, Field

from ..models.topic import (
    CandidateTopic,
    CandidateTopicsOutput,
    MiniArcChapter,
    MiniArcOutline,
    TitleSynopsisReport,
    TopicResearchState,
)


class TopicCard(BaseModel):
    genre_name: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=35)
    synopsis: str = Field(min_length=20, max_length=260)
    setting: str = Field(min_length=1, max_length=80)
    hook: str = Field(min_length=1, max_length=80)
    conflict: str = Field(min_length=1, max_length=80)
    event: str = Field(min_length=1, max_length=80)
    pleasure: str = Field(min_length=1, max_length=80)


class ChapterBeat(BaseModel):
    chapter_number: int
    goal: str = Field(min_length=1, max_length=60)
    conflict: str = Field(min_length=1, max_length=60)
    ending_hook: str = Field(min_length=1, max_length=60)


class ChapterBeats(BaseModel):
    chapters: list[ChapterBeat] = Field(min_length=1, max_length=10)


async def make_topic_card(scout, context, index, previous):
    card = await scout.generate_structured(
        system_prompt="你是小说选题策划。只设计一个独立故事，不复制榜单原书人物、情节或书名。按字段长度精简输出，不输出评分矩阵和多组候选。",
        user_prompt=f"参考信息：\n{context[:7000]}\n已生成书名：{previous}\n生成第{index+1}个不同故事。genre_name不超过30字，title不超过25字；synopsis为80至180字简介；其余字段不超过50字。只返回一张完整选题卡。",
        response_model=TopicCard, temperature_override=.7, max_tokens_override=8192,
    )
    if card.title in previous:
        raise ValueError("模型重复了已有选题，已保存卡片保留，可重试补齐")
    return card


def research_from_cards(cards, platforms=None):
    research = TopicResearchState()
    from ..models.topic import ScanReport
    platforms = platforms or {}
    if platforms.get("feilu"):
        research.feilu_scan = ScanReport.model_validate(platforms["feilu"])
    if platforms.get("fanqie"):
        research.fanqie_scan = ScanReport.model_validate(platforms["fanqie"])
    research.candidates = CandidateTopicsOutput(topics=[])
    names = set()
    for raw in cards:
        card = TopicCard.model_validate(raw)
        name = card.genre_name if card.genre_name not in names else f"{card.genre_name} · {card.title}"
        names.add(name)
        research.candidates.topics.append(CandidateTopic(
            genre_name=name, one_line_setting=card.setting, golden_finger=card.hook,
            chapter1_conflict=card.conflict, first_event_direction=card.event, first_pleasure_wave=card.pleasure,
        ))
        research.title_synopsis.append(TitleSynopsisReport(
            genre_name=name, final_title=card.title, final_synopsis=card.synopsis,
        ))
    return research


async def prepare_manual_topics(scout, state, checkpoint=None):
    config = state.project_config
    context = f"作者题材：{config.topic_type or '、'.join(config.genre)}\n灵感：{config.inspiration}\n篇幅：{config.target_word_count}字/{config.target_chapter_count}章，按该规模构思完整故事。"
    fingerprint = hashlib.sha256(context.encode()).hexdigest()
    progress = state.topic_preparation_progress
    if progress.get("fingerprint") != fingerprint:
        progress.clear()
        progress.update(fingerprint=fingerprint, cards=[])
    for index in range(len(progress["cards"]), 4):
        card = await make_topic_card(scout,context,index,[c["title"] for c in progress["cards"]])
        progress["cards"].append(card.model_dump())
        state.topic_research = research_from_cards(progress["cards"])
        if checkpoint:
            await checkpoint(state,f"选题卡已保存 {index+1}/4：{card.title}")
    return state


async def prepare_sized_arc(scout, state, genre, topic, report, checkpoint=None):
    config = state.project_config
    identity = json.dumps([genre,topic.model_dump(),report.model_dump(),config.target_word_count,config.target_chapter_count],ensure_ascii=False)
    fingerprint = hashlib.sha256(identity.encode()).hexdigest()
    progress = state.mini_arc_preparation_progress
    if progress.get("fingerprint") != fingerprint:
        progress.clear()
        progress.update(fingerprint=fingerprint, chapters=[])
    count = config.target_chapter_count
    for start in range(len(progress["chapters"]),count,10):
        end = min(start+10,count)
        result = await scout.generate_structured(
            system_prompt="你是短篇结构规划师。只输出指定章节的精简目标、冲突、结尾钩子，每字段不超过50字。最后一章完整收束主线，不以新故事开头代替结局。",
            user_prompt=f"书名：{report.final_title}\n简介：{report.final_synopsis}\n设定：{topic.one_line_setting}\n全书{config.target_word_count}字，恰好{count}章。\n已有章节：{json.dumps(progress['chapters'],ensure_ascii=False)}\n本次只规划第{start+1}至{end}章，章号连续且不可缺失。",
            response_model=ChapterBeats, temperature_override=.5, max_tokens_override=8192,
        )
        if [ch.chapter_number for ch in result.chapters] != list(range(start+1,end+1)):
            raise ValueError(f"章节骨架必须完整覆盖第{start+1}至{end}章；此前批次已保存，可继续")
        progress["chapters"].extend(ch.model_dump() for ch in result.chapters)
        state.mini_arc_outline = {genre:MiniArcOutline(genre_name=genre,total_words=str(config.target_word_count),
            chapters=[MiniArcChapter(**ch) for ch in progress["chapters"]],arc_goal=topic.first_event_direction)}
        if checkpoint:
            await checkpoint(state,f"章节骨架已保存 {end}/{count}章")
    return state.mini_arc_outline[genre]
