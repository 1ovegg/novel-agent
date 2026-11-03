/** Actual stage status + documented agent responsibilities, without simulated telemetry. */
const AgentFlow = {
    AGENTS: [
        {id:'orchestrator', name:'编排器', caption:'统筹与流程调度', kind:'control', icon:'network', role:'调度阶段、等待确认、汇总审核并决定回退。调度逻辑本身不需要调用模型。', x:405,y:28},
        {id:'topic_scout', name:'题材分析师', caption:'选题研究 · 事件骨架', kind:'planning', icon:'search', role:'研究题材、书名简介与小事件骨架；榜单选题可能直接复用共享缓存。', x:30,y:180},
        {id:'architect', name:'世界架构师', caption:'世界规则 · 文风设定', kind:'planning', icon:'layers', role:'建立世界规则、势力、冲突和文风约定。', x:280,y:180},
        {id:'character_manager', name:'角色管理师', caption:'人物档案 · 成长弧线', kind:'planning', icon:'users', role:'创建人物档案、人物关系与成长弧线。', x:530,y:180},
        {id:'plot_planner', name:'情节规划师', caption:'故事大纲 · 章节规划', kind:'planning', icon:'route', role:'根据设定创建总体大纲，并结合记忆逐章规划场景。', x:780,y:180},
        {id:'writer', name:'小说写手', caption:'场景展开 · 正文创作', kind:'writing', icon:'pen', role:'根据章节规划和记忆生成初稿，提取事实与角色变化；接收审核反馈修改。', x:405,y:350},
        {id:'editor', name:'文字编辑', caption:'文风质量 · 叙事节奏', kind:'review', icon:'check', role:'审核一致性、人物、节奏、钩子、文风与 AI 痕迹。', x:30,y:510},
        {id:'continuity_checker', name:'连续性检查员', caption:'时间线 · 人物与因果', kind:'review', icon:'link', role:'检查时间线、人物一致性、因果与伏笔。', x:280,y:510},
        {id:'reader_simulator', name:'读者模拟器', caption:'阅读体验 · 追读意愿', kind:'review', icon:'book', role:'模拟阅读体验，评估吸引力与追读意愿。', x:530,y:510},
        {id:'reviewer', name:'对抗审稿人', caption:'漏洞排查 · 修订建议', kind:'review', icon:'shield', role:'从反方寻找漏洞并提出修订意见。', x:780,y:510},
        {id:'refiner', name:'文字打磨师', caption:'语言润色 · 细节修订', kind:'finishing', icon:'spark', role:'结合审核反馈分段润色正文，逐段保存。', x:405,y:690},
        {id:'memory_manager', name:'记忆管理师', caption:'事实沉淀 · 伏笔追踪', kind:'finishing', icon:'database', role:'更新事实、人物状态、伏笔和摘要，供下一章使用。', x:730,y:690},
    ],
    EDGES: [
        ['orchestrator','topic_scout','M405 78 H137 Q125 78 125 90 V178','调度',true,250,68],
        ['topic_scout','architect','M220 230 H278'],
        ['architect','character_manager','M470 230 H528'],
        ['character_manager','plot_planner','M720 230 H778'],
        ['plot_planner','writer','M875 280 V312 Q875 324 863 324 H512 Q500 324 500 336 V348','章节规划',false,705,314],
        ...['editor','continuity_checker','reader_simulator','reviewer'].map((id,i) => ['writer',id,`M500 450 V480 H${125+i*250} V508`]),
        ...['editor','continuity_checker','reader_simulator','reviewer'].map((id,i) => [id,'refiner',`M${125+i*250} 610 V650 H500 V688`,i === 3 ? '汇总后润色' : '',false,795,640]),
        ['refiner','memory_manager','M595 740 H728','保存记忆',false,660,730],
        ['memory_manager','plot_planner','M920 740 H968 Q980 740 980 728 V242 Q980 230 972 230','下一章 · 记忆反馈',true,965,430,-90],
        ['editor','writer','M30 560 H24 Q12 560 12 548 V412 Q12 400 24 400 H403','需修订 → 写作',true,145,390],
        ['reviewer','plot_planner','M970 560 H980 Q992 560 992 548 V154 Q992 142 980 142 H887 Q875 142 875 154 V178','需重写 → 规划',true,805,132],
    ],
    CALL_STATUS: {queued:'◷ 排队中',running:'● 正在工作',completed:'✓ 调用完成',failed:'! 调用失败',interrupted:'! 已中断',unrecorded:'未记录调用',scheduling:'● 调度中',saved:'已有阶段工作记录',unavailable:'后端追踪未启用'},
    selectedAgent: null, inspectorOpen: false, selectedCall: null, projectId: null, detailKey: null, requestVersion: 0,
    STATUS: {idle:'尚未开始', initialized:'尚未开始', editing:'自主创作', running:'执行中', waiting:'等待确认', paused:'已保存，可继续', interrupted:'已中断，可继续', failed:'执行失败', error:'执行失败', completed:'已完成'},
    STAGES: [
        {phase:'topic_selection', title:'选题研究', agents:['题材分析师'], detail:'结合自主灵感或今日榜单，研究题材、书名与简介。'},
        {phase:'mini_arc_outline', title:'小事件大纲', agents:['题材分析师'], detail:'规划开篇事件、章节目标与故事钩子。'},
        {phase:'bible_construction', title:'世界观构建', agents:['世界架构师'], detail:'建立世界规则、势力、冲突与文风约定。'},
        {phase:'character_creation', title:'角色创建', agents:['角色管理师'], detail:'逐个创建人物，补全关系与成长弧线。'},
        {phase:'master_outline', title:'总体大纲', agents:['情节规划师'], detail:'规划主线、支线、分卷与关键转折。'},
        {phase:'chapter_planning', title:'章节规划', agents:['情节规划师'], detail:'确定本章场景、目标、冲突与信息投放。'},
        {phase:'chapter_writing', title:'章节写作', agents:['小说写手'], detail:'依据场景规划、人物设定与记忆生成初稿。'},
        {phase:'quality_review', title:'质量审核', agents:['文字编辑','连续性检查员','读者模拟器','对抗审稿人'], detail:'并行检查质量、人物、时间线、因果和阅读体验。'},
        {phase:'polish_revision', title:'润色修订', agents:['文字打磨师'], detail:'分段调整语言、节奏、对话和章末钩子，逐段保存。'},
        {phase:'memory_update', title:'记忆更新', agents:['记忆管理师'], detail:'更新事实、人物状态、伏笔与摘要，进入下一章。'},
    ],

    stageState(stage, index, task, pipeline = {}) {
        const current = this.STAGES.findIndex(item => item.phase === task.phase);
        if (task.status === 'completed') return 'done';
        if (index === current) return ({running:'running', waiting:'waiting', failed:'failed', error:'failed', paused:'paused', interrupted:'paused', editing:'editing'})[task.status] || 'pending';
        const key = ['topic','arc','bible','chars','outline'][index];
        if (key && pipeline[key] === 'done') return 'done';
        return current > index ? 'done' : 'pending';
    },

    historyCalls: [], historyAgent: null, historyProject: null, historyVersion: 0,

    callsFor(id, data) {
        const history = data?.project_id && data.project_id === this.historyProject && id === this.historyAgent ? this.historyCalls : [];
        const latest = data?.agent_activity?.[id]?.latest;
        const calls = [...history, ...(latest ? [latest] : []), ...(data?.agent_calls || [])].filter(call => call.agent === id);
        return [...new Map(calls.map(call => [call.id || call,call])).values()].sort((a,b) => (a.order || 0) - (b.order || 0)).reverse();
    },

    agentState(id, data) {
        if (data && !Array.isArray(data.agent_calls)) return 'unavailable';
        const calls = this.callsFor(id, data);
        if (calls.some(call => call.status === 'running')) return 'running';
        if (calls.some(call => call.status === 'queued')) return 'queued';
        if (id === 'orchestrator' && data?.project?.status === 'running') return 'scheduling';
        return calls[0]?.status || (data?.saved_agent_activity?.[id] ? 'saved' : 'unrecorded');
    },

    selectAgent(id, app) {
        this.selectedAgent = id; this.inspectorOpen = true; this.selectedCall = null; this.detailKey = null;
        this.renderGraph(app, app._flowFrozen ? this.frozenData : app._flowRuntime);
        document.getElementById('flow-inspector-close').focus({preventScroll:true});
        const version = ++this.historyVersion, project = app.currentProjectId;
        if (!project) return;
        API.agentCalls(project,id).then(result => {
            if (version !== this.historyVersion || project !== app.currentProjectId || this.selectedAgent !== id || !this.inspectorOpen) return;
            this.historyAgent = id; this.historyProject = project; this.historyCalls = result.calls;
            this.detailKey = null;
            this.renderInspector(app, app._flowFrozen ? this.frozenData : app._flowRuntime);
            const saved = document.getElementById('agent-saved-work');
            saved.hidden = !result.saved_work || !!result.calls.length;
            document.querySelector('#agent-detail .agent-model-payloads').hidden = !saved.hidden;
            if (!saved.hidden) {
                document.getElementById('agent-call-meta').textContent = '旧版本未保存原始调用；下方可查看已保存的阶段成果。';
                saved.querySelector('p').textContent = result.saved_work.notice;
                saved.querySelector('pre').textContent = JSON.stringify({保存时间:result.saved_work.updated_at,工作日志:result.saved_work.logs,已保存成果:result.saved_work.artifacts},null,2);
            }
        }).catch(error => {
            if (version !== this.historyVersion || !this.inspectorOpen) return;
            document.getElementById('agent-call-error').textContent = `历史记录读取失败：${error.message}。若提示接口不存在，请重启后端加载新版本。`;
        });
    },

    closeInspector(app) {
        const previousAgent = this.selectedAgent;
        this.inspectorOpen = false; this.selectedAgent = null; this.selectedCall = null;
        this.detailKey = null; ++this.requestVersion;
        ++this.historyVersion;
        this.renderGraph(app, app._flowFrozen ? this.frozenData : app._flowRuntime);
        document.querySelector(`[data-agent="${previousAgent}"]`)?.focus({preventScroll:true});
    },

    selectCall(id, app) {
        this.selectedCall = id; this.detailKey = null;
        this.renderInspector(app, app._flowFrozen ? this.frozenData : app._flowRuntime);
    },

    icon(name) {
        const paths = {
            network:'<rect x="8" y="3" width="8" height="6" rx="2"/><path d="M12 9v4M5 13h14M5 13v3m14-3v3"/><rect x="2" y="16" width="6" height="5" rx="1.5"/><rect x="16" y="16" width="6" height="5" rx="1.5"/>',
            search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
            layers:'<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
            users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
            route:'<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h9a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h9"/>',
            pen:'<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14l-1 7 6-2"/>',
            check:'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 11 3 3 5-6M8 18h8"/>',
            link:'<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 1)"/>',
            book:'<path d="M12 5v16M3 4h4a5 5 0 0 1 5 2 5 5 0 0 1 5-2h4v15h-4a5 5 0 0 0-5 2 5 5 0 0 0-5-2H3V4Z"/>',
            shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="M12 8v5m0 3v.1"/>',
            spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7 0v4m-2-2h4"/>',
            database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.network}</svg>`;
    },

    renderGraph(app, data) {
        const target = document.getElementById('agent-graph');
        if (!target.querySelector('svg')) {
            target.innerHTML = `<svg viewBox="0 0 1000 830" aria-hidden="true"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs><rect class="graph-review-band" x="22" y="500" width="956" height="120" rx="18"/>${[[166,'01','创作准备'],[336,'02','章节创作'],[496,'03','并行审核'],[676,'04','润色与记忆']].map(([y,n,title]) => `<text class="graph-lane-label" x="30" y="${y}">${n} / ${title}</text>`).join('')}${this.EDGES.map(([from,to,path,label,dashed,x,y,rotate]) => `<g data-from="${from}" data-to="${to}" class="graph-edge ${dashed ? 'dashed' : ''}"><path d="${path}" marker-end="url(#flow-arrow)"/>${label ? `<text x="${x}" y="${y}"${rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : ''}>${label}</text>` : ''}</g>`).join('')}</svg>` + this.AGENTS.map(agent => `<button type="button" class="graph-agent" data-kind="${agent.kind}" data-agent="${agent.id}" style="left:${agent.x/10}%;top:${agent.y/8.3}%"><span class="graph-agent-header"><span class="graph-agent-icon">${this.icon(agent.icon)}</span><span class="graph-agent-identity"><strong>${agent.name}</strong><small>${agent.caption}</small></span></span><span class="graph-agent-footer"><span class="graph-state"></span><span class="graph-metrics"></span><span class="graph-open" aria-hidden="true">↗</span></span></button>`).join('');
            target.addEventListener('click', event => {
                const button = event.target.closest('[data-agent]');
                if (button) this.selectAgent(button.dataset.agent, app);
            });
        }
        this.AGENTS.forEach(agent => {
            const button = target.querySelector(`[data-agent="${agent.id}"]`);
            const state = this.agentState(agent.id,data), count = data?.agent_activity?.[agent.id]?.count || this.callsFor(agent.id,data).length;
            button.className = `graph-agent ${state} ${agent.id === this.selectedAgent ? 'selected' : ''}`;
            button.setAttribute('aria-pressed', String(agent.id === this.selectedAgent));
            button.setAttribute('aria-expanded', String(this.inspectorOpen && agent.id === this.selectedAgent));
            button.setAttribute('aria-controls', 'flow-inspector');
            button.querySelector('.graph-state').textContent = agent.id === 'orchestrator' && state === 'unrecorded' ? ({paused:'已暂停',interrupted:'已中断',waiting:'等待确认',completed:'已完成',failed:'执行失败'}[data?.project?.status] || this.STATUS[data?.project?.status] || '等待启动') : ({saved:'已有成果',unavailable:'追踪未启用',unrecorded:'暂无调用',completed:'调用完成',running:'正在工作',queued:'排队中',failed:'调用失败',interrupted:'已中断',scheduling:'调度中'}[state] || state);
            button.querySelector('.graph-metrics').textContent = count ? `${count} 次调用` : '查看详情';
            button.setAttribute('aria-label', `${agent.name}，${button.querySelector('.graph-state').textContent}，查看工作详情`);
        });
        target.querySelectorAll('.graph-edge').forEach(edge => {
            edge.classList.toggle('related', [edge.dataset.from,edge.dataset.to].includes(this.selectedAgent));
            edge.classList.toggle('working', this.agentState(edge.dataset.to,data) === 'running');
        });
        this.renderInspector(app,data);
    },

    renderInspector(app, data) {
        document.getElementById('flow-inspector').hidden = !this.inspectorOpen;
        if (!this.inspectorOpen) return;
        const agent = this.AGENTS.find(item => item.id === this.selectedAgent) || this.AGENTS[0];
        const calls = this.callsFor(agent.id,data);
        const call = calls.find(item => item.id === this.selectedCall) || calls.find(item => item.status === 'running') || calls.find(item => item.status === 'queued') || calls[0];
        const panel = document.getElementById('agent-detail');
        if (panel.dataset.agent !== agent.id || panel.dataset.project !== (app.currentProjectId || '')) {
            panel.innerHTML = `<h3>${agent.name}</h3><p class="agent-responsibility">${agent.role}</p><p id="agent-live-state"></p><label for="agent-call-select">此智能体的历史调用记录</label><select id="agent-call-select"></select><div id="agent-call-meta"></div><p id="agent-call-error" role="alert"></p><div class="agent-payloads">${[['instruction','接收的指令 · System'],['input','输入与任务 · User'],['output','输出 · 模型原文']].map(([key,title]) => `<details open><summary>${title}</summary><pre id="agent-${key}"></pre></details>`).join('')}</div>`;
            panel.dataset.agent = agent.id; panel.dataset.project = app.currentProjectId || '';
            panel.querySelector('.agent-payloads').classList.add('agent-model-payloads');
            panel.querySelector('.agent-model-payloads').insertAdjacentHTML('beforebegin','<section id="agent-saved-work" class="agent-payloads" hidden><h4>已保存的阶段工作</h4><p class="muted"></p><details open><summary>工作日志与已保存成果</summary><pre></pre></details></section>');
            panel.querySelector('select').addEventListener('change', event => this.selectCall(event.target.value,app));
        }
        document.getElementById('agent-live-state').textContent = this.agentState(agent.id,data) === 'unavailable' ? '后端尚未启用调用追踪，请重启服务' : agent.id === 'orchestrator' && !calls.length ? (this.STATUS[data?.project?.status] || '等待启动') : this.CALL_STATUS[this.agentState(agent.id,data)];
        const select = document.getElementById('agent-call-select');
        const optionsKey = JSON.stringify(calls.map(item => [item.id,item.status]));
        if (select.dataset.key !== optionsKey) {
            select.innerHTML = calls.map(item => `<option value="${app._esc(item.id)}">${app._esc(`${item.chapter ? '第'+item.chapter+'章 · ' : ''}${this.STAGES.find(stage => stage.phase === item.phase)?.title || '模型任务'} · ${new Date(item.started_at).toLocaleTimeString('zh-CN')} · ${this.CALL_STATUS[item.status] || item.status}`)}</option>`).join('') || '<option>暂无调用记录</option>';
            select.dataset.key = optionsKey;
        }
        select.disabled = !calls.length; if (call) select.value = call.id;
        if (call) {
            panel.querySelector('.agent-model-payloads').hidden = false;
            document.getElementById('agent-saved-work').hidden = true;
        }
        const key = JSON.stringify([app.currentProjectId,agent.id,call?.id,call?.updated_at,call?.status]);
        if (key === this.detailKey) return;
        this.detailKey = key;
        const version = ++this.requestVersion;
        const error = document.getElementById('agent-call-error'); error.textContent = '';
        const meta = document.getElementById('agent-call-meta');
        meta.textContent = call ? `${call.model || '未知模型'} · ${call.elapsed_seconds != null ? call.elapsed_seconds + ' 秒' : '尚未结束'}${call.queue_seconds != null ? ' · 排队 '+call.queue_seconds+' 秒' : ''}${call.input_tokens != null ? ' · Token '+call.input_tokens+' / '+call.output_tokens : ''}` : '尚无可展示的实际调用';
        const empty = !app.currentProjectId ? '请选择项目查看工作记录。' : agent.id === 'orchestrator' ? '编排器通过工作流代码调度其他智能体；当前调度情况见上方项目状态和后端运行记录。' : '未记录。旧任务无法补录；后续实际调用会自动出现在这里。';
        ['instruction','input','output'].forEach(field => document.getElementById(`agent-${field}`).textContent = call ? '正在读取…' : empty);
        if (!call) return;
        API.agentCall(app.currentProjectId,call.id).then(record => {
            if (version !== this.requestVersion) return;
            ['instruction','input','output'].forEach(field => document.getElementById(`agent-${field}`).textContent = record[field] || (field === 'output' && ['running','queued'].includes(record.status) ? '等待模型返回；非流式调用完成后显示输出。' : '未记录内容'));
            error.textContent = record.error || '';
            if (record.finish_reason === 'length' || record.finish_reason === 'max_tokens') error.textContent = '模型输出达到长度上限，结果可能被截断；格式校验或重试记录请查看后端日志。';
        }).catch(err => {
            if (version !== this.requestVersion) return;
            error.textContent = `读取失败：${err.message}`; this.detailKey = null;
            ['instruction','input','output'].forEach(field => document.getElementById(`agent-${field}`).textContent = '无法读取，下一次同步会重试。');
        });
    },

    render(app) {
        if (!document.getElementById('view-flow').classList.contains('active')) return;
        const select = document.getElementById('flow-project-select');
        const key = JSON.stringify(app._projects.map(p => [p.project_id,p.title]));
        if (select.dataset.key !== key) {
            select.innerHTML = '<option value="">请选择项目</option>' + app._projects.map(p => `<option value="${app._esc(p.project_id)}">${app._esc(p.title || '未命名项目')}</option>`).join('');
            select.dataset.key = key;
        }
        select.value = app.currentProjectId || '';
        document.getElementById('flow-freeze').textContent = app._flowFrozen ? '恢复刷新' : '暂停刷新';
        if (this.projectId !== app.currentProjectId) {
            this.projectId = app.currentProjectId; this.selectedCall = null; this.detailKey = null; ++this.requestVersion;
            this.inspectorOpen = false; this.selectedAgent = null;
            this.historyCalls = []; this.historyProject = null; this.historyAgent = null; ++this.historyVersion;
        }
        if (app._flowFrozen) return;
        const data = app._flowRuntime;
        this.frozenData = data;
        this.renderGraph(app,data);
        const task = data?.project || {};
        const connected = !!data;
        const connection = document.getElementById('flow-connection');
        connection.textContent = connected ? '服务在线' : '等待读取';
        connection.className = `runtime-pill ${connected ? 'online' : ''}`;
        const currentStage = this.STAGES.find(stage => stage.phase === task.phase);
        document.getElementById('flow-status').textContent = `${currentStage ? currentStage.title + ' · ' : ''}${this.STATUS[task.status] || '尚未开始'}`;
        document.getElementById('flow-message').textContent = task.detail && task.status === 'running' ? task.detail : task.message || '选择一个项目，即可查看保存的生成进度。';
        if (data && !Array.isArray(data.agent_calls)) {
            connection.textContent = '后端版本过旧';
            document.getElementById('flow-message').textContent = '此服务尚未加载智能体调用追踪。请保存进度并重启当前后端，避免把未记录误认为未调用。';
        }
        document.getElementById('flow-updated').textContent = data?.server_time ? `最近同步 ${new Date(data.server_time).toLocaleTimeString('zh-CN')} · 书库中的项目可随时切换` : '等待后端状态';
        document.getElementById('flow-resume').disabled = !app.currentProjectId || task.status === 'running';
        document.getElementById('flow-pause').disabled = !app.currentProjectId || !['running','waiting'].includes(task.status);
        const onlyErrors = document.getElementById('flow-errors-only').checked;
        const events = (data?.events || []).filter(event => !onlyErrors || ['warning','warn','error','critical'].includes(event.level)).slice().reverse();
        const eventKey = JSON.stringify([onlyErrors,events]);
        const target = document.getElementById('flow-events');
        if (target.dataset.key !== eventKey) {
            target.innerHTML = events.map(event => `<li class="${['error','warning','critical'].includes(event.level) ? event.level : 'info'}"><div class="event-meta"><time>${app._esc(new Date(event.time).toLocaleTimeString('zh-CN'))}</time><span>${app._esc(event.level.toUpperCase())}</span></div><span>${app._esc(event.message)}</span></li>`).join('') || '<li class="muted">暂无符合条件的运行记录</li>';
            target.dataset.key = eventKey;
        }
    },
};
if (typeof module !== 'undefined') module.exports = AgentFlow;
