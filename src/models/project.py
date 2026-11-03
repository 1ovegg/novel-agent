"""Project configuration and metadata models."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .common import LengthCategory, ProjectStatus, WorkflowPhase


class ProjectConfig(BaseModel):
    """User-provided project configuration (Phase 1 input)."""

    topic_source: Literal["manual", "rankings"] | None = None
    topic_type: str = Field(default="", max_length=200)

    # --- Core identity ---
    title: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Novel title / project name, also used as the folder name",
    )
    inspiration: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="One-sentence inspiration or core idea for the novel",
    )
    genre: list[str] = Field(
        ...,
        min_length=1,
        description="Genre tags, e.g. ['玄幻', '修仙']",
    )
    target_readers: str = Field(
        ...,
        min_length=1,
        description="Target audience description, e.g. '18-35岁男性读者'",
    )
    target_length: LengthCategory = Field(
        default=LengthCategory.NOVEL,
        description="Rough length category",
    )
    target_word_count: int = Field(
        default=80000,
        ge=1000,
        le=500000,
        description="Target total word count",
    )
    target_chapter_count: int | None = Field(default=None, ge=1, le=200)

    @model_validator(mode="after")
    def validate_size(self):
        if self.target_chapter_count and self.target_word_count < self.target_chapter_count * 300:
            raise ValueError("平均每章至少300字，请减少章节数或增加总字数")
        if self.target_chapter_count:
            self.target_length = LengthCategory.SHORT_STORY if self.target_word_count <= 10000 else LengthCategory.NOVELLA if self.target_word_count < 40000 else LengthCategory.NOVEL if self.target_word_count <= 100000 else LengthCategory.EPIC
        return self

    def chapter_word_target(self, number: int) -> int:
        count = self.target_chapter_count or max(10, self.target_word_count // 4000)
        average, remainder = divmod(self.target_word_count, count)
        return average + (1 if number <= remainder else 0)

    # --- Style & tone ---
    tone: str = Field(
        default="",
        description="Desired tone, e.g. 'dark', 'light', 'whimsical', 'gritty'",
    )
    style_reference: str | None = Field(
        default=None,
        description="Reference works or authors for style emulation",
    )
    language: str = Field(
        default="zh-CN",
        description="Primary writing language (BCP 47 tag)",
    )

    # --- Constraints ---
    taboo_content: list[str] = Field(
        default_factory=list,
        description="Content to avoid, e.g. ['色情', '过度暴力', '政治敏感']",
    )
    special_requirements: list[str] = Field(
        default_factory=list,
        description="Any special requirements or notes",
    )


class ProjectMeta(BaseModel):
    """Runtime project metadata tracked across the workflow."""

    @field_validator("created_at", "updated_at", mode="before")
    @classmethod
    def normalize_timestamp(cls, value):
        # Older workspace YAML can contain a timestamp object instead of a string.
        return value.isoformat() if isinstance(value, datetime) else value

    project_id: str = Field(..., description="Unique project identifier")
    title: str | None = Field(default=None, description="Novel title (can be set later)")
    created_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(),
        description="ISO timestamp of project creation",
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(),
        description="ISO timestamp of last update",
    )
    status: ProjectStatus = Field(
        default=ProjectStatus.INITIALIZED,
        description="Current project status",
    )
    current_phase: WorkflowPhase = Field(
        default=WorkflowPhase.IDLE,
        description="Current workflow phase",
    )
    current_chapter: int = Field(default=0, description="Current chapter being worked on (0 = not started)")
    total_chapters: int = Field(default=0, description="Planned total chapter count")
    iteration_count: int = Field(default=0, description="Total review iterations so far")
    word_count_written: int = Field(default=0, description="Total words written so far")
