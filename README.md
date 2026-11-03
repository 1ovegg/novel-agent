# Novel Agent

[![CI](https://github.com/HuangLeijiana/novel-agent/actions/workflows/test.yml/badge.svg)](https://github.com/HuangLeijiana/novel-agent/actions/workflows/test.yml)

**Multi-agent AI novel writing system** — 12 specialized agents collaborate through a LangGraph pipeline to produce complete, coherent web novels from idea to finished chapters.

> 🤖 Powered by LLMs (ModelScope, DeepSeek, Claude, OpenAI, Ollama) | 🎨 Frontend control panel | 📋 Structured planning pipeline

---

## Features

- **12-Agent Pipeline** — Topic Scout → Architect → Character Manager → Plot Planner → Writer → Editor → Continuity Checker → Reader Simulator → Reviewer → Refiner → Memory Manager → Orchestrator
- **Provider Agnostic** — Works with ModelScope (free), DeepSeek, DashScope, Claude, OpenAI, OpenRouter, or local Ollama
- **Structured Planning** — World bible, character profiles, master outline, scene-level chapter plans before a single word is written
- **Quality Control** — Multi-pass review: editorial feedback → continuity checks → reader simulation → adversarial review → refinement
- **Memory System** — Tracks world facts, character states, foreshadowing, and continuity across the entire novel
- **Web UI** — Real-time control panel with WebSocket progress updates
- **Zero-cost Start** — ModelScope free tier (2000 calls/day) lets you generate a complete novel for free

## Quick Start

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

### 1. Clone & Install

```bash
git clone https://github.com/HuangLeijiana/novel-agent.git
cd novel-agent
uv sync
```

### 2. Configure (30 seconds)

```bash
cp .env.example .env
```

Edit `.env` and choose your LLM provider. **To start for free with ModelScope:**

```bash
# 1. Register at https://modelscope.cn → get your SDK Token
# 2. Uncomment these three lines in .env:
OPENAI_API_KEY=ms-your-token-here
OPENAI_BASE_URL=https://api-inference.modelscope.cn/v1
DEFAULT_PROVIDER=modelscope
DEFAULT_MODEL=Qwen/Qwen3-235B-A22B
```

Other providers: DeepSeek (¥5-10/novel), DashScope (¥4/M tokens), Claude ($15/M output), Ollama (free, local GPU).

> **成本口径（重要）**：`src/utils/cost_calculator.py` 的单价表按各 provider 的**原生币种**记录——Anthropic / OpenAI / OpenRouter 为 **USD / 1M tokens**，DashScope（通义千问）/ ModelScope 为 **CNY**。币种映射见 `PROVIDER_CURRENCY`；`estimate.format(display_currency="CNY")` 可折算展示，`print_cost_comparison()` 会同时打印原生币种与 USD 近似值。折算汇率是 `USD_TO_CNY`（默认 7.2），**仅用于横向比较，不用于结算**；表内数值均为量级估算，实际以各 provider 官方价格页 / 账单为准。

### 3. Launch

```bash
uv run novel-agent
# Or: uv run python -m src.main
```

Open **http://127.0.0.1:8000** in your browser.

### 4. Write Your Novel

1. Enter your novel idea, genre, and target audience
2. Click through the pipeline phases — each phase builds on the previous one
3. Watch as agents collaborate: outline → characters → chapters → review → polish
4. Export finished chapters as `.docx`

## Architecture

### 本地工作台：每日榜单与选题入口

- 服务启动后在后台准备当天的榜单，日期按北京时间计算。原始抓取内容、解析结果与热门题材保存到 `workspace/daily_rankings/YYYY-MM-DD.json`。
- 当天重启服务或创建多个小说项目都会复用同一份缓存。第二天启动时准备新日期的数据。失败结果也会保留，避免反复重试；可以在页面点击“重试今日扫榜”。
- 创作从“选题研究”开始。输入题材类型或故事灵感即可直接研究，不要求扫榜成功；没有方向时展开“今日榜单参考”，读取缓存后研究选题。
- 工作台侧边的“后台状态”显示当前阶段、心跳、耗时、等待确认、错误与最近运行记录。窄屏时状态面板显示在上方，运行记录可展开。刷新页面后从书库打开项目可恢复当前服务内的任务状态。
- 左侧固定的“今日扫榜”在工作台、书库和写作助手中都可见；“已完成（部分可用）”表示扫榜已经结束，只有部分平台成功。抓取与解析分别有超时限制，中断也会显示终态，不会一直显示扫榜中。
- “返回自主创作”可在选题阶段停止榜单研究并保留原结果；已进入后续阶段时会打开新草稿，原项目不受影响。普通页面切换不会重置项目。
- 输入草稿、勾选题材和编辑后的书名简介按项目保存在浏览器本地；已完成阶段另存为项目内的 `workflow_state.json`。刷新页面会恢复当前项目，服务重启后也能从已保存阶段继续，无须重复已完成的研究。
- “保存并暂停”会取消当前尚未完成的模型请求并保存进度；重新打开后点击“继续上次生成”，从当前阶段继续。角色创建按单个角色、人物关系、成长弧线分别保存；已保存的小步骤不会重跑。等待人工确认的阶段只恢复确认界面，不会自动跳过确认。
- 每个项目的运行记录保存在 `runtime_events.jsonl`，重启后仍可查看。格式不合法的模型响应保存在项目的 `diagnostics/`，含结束原因和 token 用量；系统会进行一次受限的格式重试，不会无限重复请求。
- 润色新任务按不超过 1200 字的原文分段进行，只携带相邻段落作为衔接参考；已有 900 字分段进度仍沿用原分段续接。每段完成即保存。修改初稿、文风或作者反馈后会重新润色。DeepSeek 兼容平台可设置 `OPENAI_THINKING_ENABLED=false`，避免思考过程耗尽正文输出额度；留空保持平台默认，仅对模型名含 DeepSeek 的请求生效。
- 写作先保存完整初稿，再按最多 1500 字的片段提取事实与角色变化，每段完成即保存；提取失败不再导致整章重写。章节计数仅在完整处理完一章后递增，阶段标记需与实际章节文件匹配，防止跳章。
- 我的书库支持编辑书名、查看和编辑已完成章节、点击书名继续生成。删除前会停止项目任务，将整个项目移入 `workspace/.trash/projects/`，可通过页面上的“撤销删除”恢复。章节正文编辑前会保留旧版本至项目的 `edit_history/`。
- 智能体流程页展示 12 个智能体的协作关系图，包含并行审核、修改回退和逐章记忆反馈。真实模型调用每 3 秒同步，区分排队、执行、完成、失败与中断；点击节点可查看历史调用的指令（System）、输入任务（User）、模型原文输出、模型、章节、耗时和 token 用量。记录按项目保存在 `agent_calls/`，详情按需加载，重启后仍可查询；旧任务不补造调用记录，模型调用完成不等于阶段审核通过。后端日志支持警告/错误筛选和暂停显示刷新。原独立智能写作助手页面及其上传、对话接口已移除，生成流水线中的编辑、审核、润色智能体仍正常使用。
- 章节预览页支持边生成边阅读已保存的初稿、润色片段和润色正文，每 3 秒同步，不会启动或中断生成。工作台和书库均有直接入口。
- 新建选题可选 5000 字/5章、1万字/10章、2万字/20章或自定义总字数与章节数，平均每章至少300字。预算会贯穿事件骨架、总体大纲、逐章规划与写作，实际成文长度允许自然浮动；旧项目保留原计划。复用现有情节规划智能体，无需新增智能体。
- 新建的自定义篇幅项目采用精简选题卡：每次只生成一个故事及简介，完成即保存，避免12个题材、评分矩阵和多组书名挤在大响应里。事件骨架最多每10章一批，失败只重试当前批次。
- 每日榜单解析后会在后台预生成4张独立选题卡及简介，与当日榜单共同保存至 `workspace/daily_rankings/YYYY-MM-DD.json`。使用榜单选题只读缓存，不重复研究；可单独重试未完成卡片，不重新扫榜。原有当日榜单缓存会直接补选题，无需再次抓取。页面展示全部已缓存书籍，详情可展开。
- 默认 `EDITOR_REVIEW_MODE=combined` 将主编辑的六维审核合为一次模型调用，`detailed` 保留原多轮检查。`LLM_MAX_CONCURRENT_REQUESTS=3` 限制非流式模型请求并发以减少限流；日志记录实际请求耗时、排队时间和结束原因。审核缺项会明确标记，不计为审核通过。
- 可选 RAG 缺少 `sentence-transformers` 或 `chromadb` 时自动跳过语义检索和向量索引，只提示一次；章节摘要、事实和角色状态等结构化记忆继续使用。可用 `RAG_ENABLED=false` 显式关闭；启用完整语义检索需安装 `[rag]` 可选依赖和相应嵌入模型。
- 新增 API：`GET /api/rankings/today`、`POST /api/rankings/refresh`、`GET /api/runtime?project_id=...`。新工作流可向 `POST /api/projects/{id}/start` 传入 `topic_source`（`manual` / `rankings`）、`topic_type` 和 `inspiration`。
- 飞卢抓取需要 Playwright 和 Chromium；缺少浏览器依赖、榜单站点不可达或 AI 解析失败时，界面会显示失败或部分可用，不会把失败当作成功缓存。

启动命令：`uv run python -m src.main`（或 `.venv\Scripts\python.exe -m src.main`）。

智能体追踪需要运行更新后的后端：修改 Python 代码后请重启服务，前端静态文件刷新不会更新已启动的 Python 进程。统一访问 `http://127.0.0.1:8000`，避免同时启动多个后端读写同一工作目录。旧后端缺少追踪接口时，流程页会提示重启；旧项目仍可查看已保存的阶段日志与成果，但无法还原当时未保存的完整提示词。每个智能体的历史调用单独加载，不受项目最近 200 次调用窗口影响。

```
┌──────────────────────────────────────────────────────────┐
│                    Web UI (Vanilla JS)                    │
│              Real-time WebSocket progress                 │
└──────────────────────┬───────────────────────────────────┘
                       │ FastAPI + WebSocket
┌──────────────────────▼───────────────────────────────────┐
│                   Orchestrator Agent                      │
│              Coordinates 12-agent pipeline                │
└──────┬───────┬───────┬───────┬───────┬──────────────────┘
       │       │       │       │       │
  ┌────▼──┐ ┌─▼──┐ ┌──▼──┐ ┌─▼───┐ ┌─▼──────┐
  │Topic  │ │Arch│ │Char │ │Plot │ │Writer   │   Creative
  │Scout  │ │itect│ │Mgr │ │Plan │ │(2-pass) │   Tier
  └───────┘ └────┘ └─────┘ └─────┘ └────────┘
  ┌───────┐ ┌────┐ ┌─────┐ ┌─────┐ ┌────────┐
  │Editor │ │Cont│ │Read │ │Rev  │ │Refiner │   Review
  │       │ │inuity│ │Sim  │ │iewer│ │        │   Tier
  └───────┘ └────┘ └─────┘ └─────┘ └────────┘
                       │
              ┌────────▼────────┐
              │  Memory Manager  │   State
              │ (facts, states,  │   Tier
              │  foreshadowing)  │
              └─────────────────┘
```

### Project Structure

```
novel-agent/
├── src/
│   ├── agents/          # 12 AI agents (writer, editor, reviewer, etc.)
│   ├── api/             # FastAPI server, WebSocket, routes
│   ├── config/          # Settings, model assignments
│   ├── frontend/        # Web UI (index.html + vanilla JS + CSS)
│   ├── graph/           # ★ LangGraph workflow — the real runtime engine
│   │   ├── workflow.py  #   StateGraph: Phase 0 → bible → characters → outline → chapter loop
│   │   ├── nodes.py     #   Phase nodes (executors + persistence + progress broadcasts)
│   │   └── edges.py     #   Conditional routing: review accept/revise/rewrite, next-chapter/done
│   ├── llm/             # Model scheduler, providers, JSON repair
│   ├── models/          # Pydantic data models (outline, bible, chapter, etc.)
│   ├── storage/         # Workspace file I/O
│   └── utils/           # Jinja2 templates, helpers
├── tests/               # Unit + integration tests
├── .env.example         # Configuration template with 5 provider presets
├── pyproject.toml
└── README.md
```

### How the graph runs

The workflow is a **real LangGraph StateGraph** (`src/graph/workflow.py`) — the
FastAPI layer invokes it directly; there is no parallel hand-written loop.

- **Routing is live**: `edges.py` decides review accept/revise/rewrite (with
  `MAX_REVIEW_ITERATIONS` forcing acceptance) and the next-chapter/done
  transition; chapters loop until the outline's chapter count is reached.
- **Human-in-the-loop is `interrupt()`-based**: after each top-level phase
  (scan → topic → mini-arc → bible → characters → outline) the graph pauses;
  the API layer broadcasts `phase_blocked` and resumes with
  `Command(resume=...)` when you confirm — persisted by the checkpointer
  (MemorySaver, or AsyncSqliteSaver via `build_async_workflow(db_path)`).
- **Resume & skip are preserved**: completed artifacts are detected from disk,
  so re-running a project skips finished phases and resumes mid-chapter.


## Pipeline Phases

| Phase | Agent | What It Does |
|-------|-------|-------------|
| 1 | **Topic Scout** | Market analysis, trending topics, title generation |
| 2 | **Architect** | World-building bible (geography, magic system, factions) |
| 3 | **Character Manager** | Character profiles with arcs, flaws, motivations |
| 4 | **Plot Planner** | Master outline with volumes, chapters, turning points |
| 5 | **Writer** | Chapter drafts with scene-level planning + auto-expansion |
| 6 | **Editor** | Structural feedback, pacing, dialogue review |
| 7 | **Continuity Checker** | Fact consistency, timeline validation |
| 8 | **Reader Simulator** | Reader engagement scoring, "boring" detection |
| 9 | **Reviewer** | Adversarial review — finds blind spots |
| 10 | **Refiner** | Applies edits based on review feedback |
| ∞ | **Memory Manager** | Runs continuously: tracks world facts, character states, foreshadowing |

## Configuration

### Provider Presets

| Provider | Model (Quality) | Cost | Setup |
|----------|----------------|------|-------|
| **ModelScope** | Qwen3-235B | Free (2000 calls/day) | SDK Token |
| **DeepSeek** | deepseek-chat | ~¥5-10/novel | API Key |
| **DashScope** | qwen-max | ¥4/M output tokens | API Key |
| **Claude** | claude-sonnet-4 | $15/M output | API Key |
| **OpenAI** | gpt-4o | $10/M output | API Key |
| **OpenRouter** | 200+ models | Varies | API Key |
| **Ollama** | qwen3:32b | Free (local GPU) | None |

### Per-Agent Overrides

You can assign different models to different agents for cost optimization:

```bash
# Writer needs the best model — use Claude
WRITER_MODEL=anthropic:claude-sonnet-4-20250514
# Reviewers can use cheaper models
EDITOR_MODEL=deepseek-chat
CONTINUITY_CHECKER_MODEL=deepseek-chat
```

### Key Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_CHAPTER_WORD_COUNT` | 3000 | Target words per chapter |
| `MAX_REVIEW_ITERATIONS` | 3 | Max edit-review cycles |
| `MIN_REVIEW_SCORE_ACCEPT` | 6.5 | Minimum score to pass review |
| `MAX_CONTEXT_CHAPTERS` | 5 | Recent chapters in context window |
| `WORKSPACE_ROOT` | ./workspace | Where novels are saved |

## Development

```bash
# Install dev dependencies
uv sync --extra dev

# Run unit tests (no API key needed, runs in < 1s)
uv run pytest tests/test_unit.py -v

# Run integration tests (needs API key configured in .env)
uv run pytest tests/ -v -k "modelscope"

# Run all tests
uv run pytest tests/ -v

# Run the app in dev mode
uv run python -m src.main
```

### Docker

```bash
# Build and run with docker-compose
cp .env.example .env   # edit with your API key first
docker compose up -d

# Or build manually
docker build -t novel-agent .
docker run -p 8000:8000 -v $(pwd)/.env:/app/.env:ro -v $(pwd)/workspace:/app/workspace novel-agent
```

### Testing

| Type | Command | API Key | What It Tests |
|------|---------|---------|---------------|
| **Unit** | `pytest tests/ -k "not modelscope"` | No | Pydantic models, JSON repair, content safety, prompts, settings, graph, feedback (126+ tests) |
| **Integration** | `pytest tests/ -v -k "modelscope"` | Yes | End-to-end agent pipeline against real LLMs |

CI runs the full non-integration suite on Python 3.11/3.12/3.13 on every push and PR via GitHub Actions.

## 记忆检索评测（可复现）

RAG 记忆检索质量由 `eval/eval_rag_retrieval.py` 量化：

```bash
# 1. 安装 rag 依赖（chromadb + sentence-transformers）
uv sync --extra rag

# 2. 运行评测（数据使用仓库内 eval/fixtures/memory 的 42 条设定事实与 30 条时间线事件）
uv run python eval/eval_rag_retrieval.py
```

脚本走项目自身的 `NovelVectorStore + Embedder` 代码路径（BGE-small-zh 512 维）；每条记忆由本地 Ollama qwen3:8b 改写为自然中文检索问题后查询 top-k，统计 recall@k / MRR（Ollama 不可用时自动退化为原文查询，可用 `--bge-model` 指定本地模型路径）。

结果写入 `eval/rag_retrieval_results.json`（当前结果：42 条事实 recall@1=100%、30 条事件 recall@5=86.7%、MRR=0.78）。

## 产品评审报告（两轮，可复现）

产品侧用自研的 AI 产品验收框架（5 大维度、19 条准则、每维 1–5 分、满分 25、阻断项一票否决）对本项目做了两轮**自动评审**（评审人是框架本身，不是人工评审），报告随仓库提供：

| 版本 | 得分 | 主要变化 |
|---|---|---|
| `eval/evaluation_report.md`（v1.0） | **13.5 / 25** | 列出 3 项阻断：B1 无显式反馈入口 / B2 无 Bad Case 管理 / B3 无埋点方案 |
| `eval/evaluation_report_v2.md`（v2.0） | **16.0 / 25（+2.5）** | B1、B2 已解决，B3 降级为条件；新增 **44 条边缘用例并全部通过**；30 章成本核算 **\$12.30 → \$7.04（-43%，Anthropic 价目，USD）** |

评审框架本身（5 大维度 / 19 条准则 / 25 分制）开源在 [ai-product-evaluation](https://github.com/HuangLeijiana/ai-product-evaluation)。

## FAQ

**Q: Can I really write a complete novel for free?**
A: Yes. ModelScope provides 2000 free API calls per day. A 30-chapter novel uses ~150 calls (5 phases + 30 chapters × ~5 agent calls each).

**Q: What genre does it support?**
A: All genres. The system works with any setting — xianxia, sci-fi, romance, urban, horror. You define the genre and tone in the project config.

**Q: How much manual editing is needed?**
A: The pipeline produces complete, coherent drafts. Most users do light editing (dialogue polish, pacing tweaks) rather than rewrites. The multi-pass review system catches most issues automatically.

**Q: Does it support non-Chinese languages?**
A: The pipeline is language-aware. Set `language` in your project config. Prompt templates are in Chinese but the system works with any language the underlying LLM supports.

## License

MIT © [Huang Lei](https://github.com/HuangLeijiana)
