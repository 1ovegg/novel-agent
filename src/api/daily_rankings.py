"""One persisted ranking snapshot per Shanghai calendar day, shared by all novels."""

import asyncio
import json
import logging
from collections import Counter
from pathlib import Path

from .runtime import now_iso, redact, runtime_status

logger = logging.getLogger(__name__)


class DailyRankings:
    def __init__(self, root, scraper=None, analyzer=None, today=None, scrape_timeout=180, analysis_timeout=90, topic_preparer=None, topic_timeout=180):
        self.root = Path(root) / "daily_rankings"
        self.scraper = scraper
        self.analyzer = analyzer
        self.today = today or (lambda: now_iso()[:10])
        self.lock = asyncio.Lock()
        self.task = None
        self.current = None
        self.scrape_timeout = scrape_timeout
        self.analysis_timeout = analysis_timeout
        self.topic_preparer = topic_preparer
        self.topic_timeout = topic_timeout

    def _persist(self, value):
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / f"{value['date']}.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(value,ensure_ascii=False),encoding="utf-8")
        temporary.replace(target)
        self.current = value

    def schedule_topics(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.ensure_topics())
        return self.task

    async def ensure_topics(self):
        async with self.lock:
            cached = self._read()
            if cached and cached.get("platforms"):
                await self._prepare_topics(cached)
            return self.snapshot()

    async def _prepare_topics(self, value):
        if not self.topic_preparer or not value.get("platforms"):
            return
        cards = value.setdefault("topic_cards",[])
        value.update(topic_status="loading",topic_started_at=now_iso(),topic_message=f"正在预生成选题，已保存{len(cards)}/4张")
        self._persist(value)
        context = json.dumps({name:report.get("entries",[])[:20] for name,report in value["platforms"].items()},ensure_ascii=False)[:7000]
        try:
            for index in range(len(cards),4):
                raw = await asyncio.wait_for(self.topic_preparer(context,index,[card["title"] for card in cards]),self.topic_timeout)
                from ..agents.topic_preparation import TopicCard
                card = TopicCard.model_validate(raw.model_dump() if hasattr(raw,"model_dump") else raw)
                cards.append(card.model_dump())
                value.update(topic_message=f"已预生成并保存{len(cards)}/4张选题卡及简介",topic_updated_at=now_iso())
                self._persist(value)
            value.update(topic_status="ready",topic_message=f"今日{len(cards)}张选题卡和简介已缓存，可直接使用",topic_error=None)
        except asyncio.CancelledError:
            value.update(topic_status="interrupted",topic_message=f"选题预生成已中断，已保存{len(cards)}张；下次启动接着准备")
            self._persist(value)
            raise
        except Exception as exc:
            value.update(topic_status="partial" if cards else "failed",topic_error=redact(exc),
                         topic_message=f"已保存{len(cards)}张选题卡；剩余选题准备失败，可单独重试：{redact(exc)}")
            logger.warning("今日选题预生成未完成：%s",redact(exc))
        value["topic_updated_at"] = now_iso()
        self._persist(value)

    def _read(self):
        try:
            value = json.loads((self.root / f"{self.today()}.json").read_text(encoding="utf-8"))
            if value.get("date") == self.today():
                return value
        except (OSError, ValueError):
            pass
        return None

    def snapshot(self):
        value = self.current if self.current and self.current["date"] == self.today() else self._read()
        value = value or {"date": self.today(), "status": "idle", "message": "今日榜单尚未准备", "platforms": {}, "topics": []}
        result = {k: v for k, v in value.items() if k != "raw"}
        result["running"] = result["status"] == "loading"
        result["completed"] = result["status"] in ("ready", "partial")
        result["book_count"] = sum(len(report.get("entries", [])) for report in result.get("platforms", {}).values())
        return result

    def schedule(self, force=False):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.ensure(force=force))
        return self.task

    async def ensure(self, force=False):
        async with self.lock:
            cached = self._read()
            if cached is not None and not force:
                self.current = cached
                if cached.get("topic_status") in (None,"loading","interrupted"):
                    await self._prepare_topics(cached)
                return self.snapshot()
            day = self.today()
            self.current = {"date": day, "status": "loading", "stage": "fetching", "started_at": now_iso(),
                            "message": "正在后台抓取今日榜单", "platforms": {}, "topics": []}
            runtime_status.log("开始准备今日榜单（北京时间，每天缓存一次）")
            result = {**self.current, "raw": {}, "errors": []}
            cancelled = False
            try:
                if self.scraper is None:
                    from ..utils.scraper import scrape_all
                    scraper = scrape_all
                else:
                    scraper = self.scraper
                raw = await asyncio.wait_for(scraper(), timeout=self.scrape_timeout)
                # Scrapers can return an explanation of failure instead of data.
                usable = {key: text for key, text in raw.items() if text and len(text) > 500}
                result["raw"] = usable
                if not usable:
                    raise ValueError("今日榜单抓取失败；可继续手动选题，或检查网络后重试")
                self.current["message"] = "榜单已抓取，正在提取书籍与题材"
                self.current["stage"] = "analyzing"
                if self.analyzer:
                    reports = await asyncio.wait_for(self.analyzer(usable), timeout=self.analysis_timeout)
                else:
                    from ..agents.orchestrator import OrchestratorAgent
                    from ..models.state import MainState
                    from .dependencies import get_scheduler
                    state = await asyncio.wait_for(OrchestratorAgent(get_scheduler()).scan_platforms(
                        MainState(), feilu_content=usable.get("feilu"), fanqie_content=usable.get("fanqie"),
                    ), timeout=self.analysis_timeout)
                    reports = {"feilu": state.topic_research.feilu_scan, "fanqie": state.topic_research.fanqie_scan}
                platforms = {}
                for key, report in reports.items():
                    if report is None:
                        continue
                    data = report.model_dump(mode="json") if hasattr(report, "model_dump") else report
                    if data.get("entries") and not data.get("scan_failed"):
                        platforms[key] = data
                    else:
                        result["errors"].append(f"{key} 未取得有效榜单")
                if not platforms:
                    raise ValueError("榜单解析未得到有效书籍；检查模型连接后重试，或使用手动选题")
                counts = Counter(
                    entry["genre"].split("/")[0].strip()
                    for report in platforms.values() for entry in report["entries"] if entry.get("genre")
                )
                result.update(
                    platforms=platforms,
                    topics=[{"name": name, "count": count} for name, count in counts.most_common(12)],
                    status="ready" if len(platforms) == 2 else "partial",
                    message="今日榜单已缓存，所有项目可复用" if len(platforms) == 2 else "部分平台可用，已缓存成功结果",
                )
            except asyncio.CancelledError:
                cancelled = True
                result.update(status="failed", message="扫榜任务已中断，可重试；手动创作不受影响")
            except TimeoutError:
                stage = "抓取榜单" if self.current.get("stage") == "fetching" else "解析榜单"
                result.update(status="failed", message=f"{stage}超时，可检查网络后重试；手动创作不受影响")
                result["errors"].append(result["message"])
            except Exception as exc:
                result.update(status="failed", message=redact(exc))
                result["errors"].append(redact(exc))
                logger.warning("每日榜单准备失败: %s", redact(exc))
            result["updated_at"] = now_iso()
            result["stage"] = "finished" if result["status"] in ("ready", "partial") else "failed"
            if result["status"] == "failed" and cached and cached.get("platforms"):
                result = {**cached, "attempt_error": result["message"], "last_attempt_at": now_iso(),
                          "message": f"本次刷新失败，保留已完成的榜单缓存。{result['message']}"}
            try:
                self.root.mkdir(parents=True, exist_ok=True)
                target = self.root / f"{day}.json"
                temporary = target.with_suffix(".tmp")
                temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
                temporary.replace(target)
            except OSError as exc:
                result.update(status="failed", message=f"保存今日榜单缓存失败：{redact(exc)}")
            self.current = result
            runtime_status.log(result["message"], "warning" if result["status"] == "failed" else "info")
            if cancelled:
                raise asyncio.CancelledError
            if result["status"] in ("ready","partial") and not result.get("topic_cards"):
                await self._prepare_topics(result)
            return self.snapshot()


_cache = None


def get_daily_rankings():
    global _cache
    from ..config.settings import get_settings
    root = get_settings().workspace_path
    if _cache is None or _cache.root.parent != root:
        async def prepare(context,index,previous):
            from ..agents.topic_preparation import make_topic_card
            from ..agents.topic_scout import TopicScoutAgent
            from .dependencies import get_scheduler
            return await make_topic_card(TopicScoutAgent(get_scheduler()),context,index,previous)
        _cache = DailyRankings(root,topic_preparer=prepare)
    return _cache
