/**
 * Novel Agent V7 — 创作流水线
 */
const App = {
    currentProjectId: null,
    ws: null,
    _projects: [],
    _workflowDone: false,
    _pipelineState: {},  // step -> 'pending' | 'active' | 'running' | 'done'

    async init() {
        this._workspaceStore = new WorkspaceStateStore(window.localStorage);
        this._workspaceEpoch = 0;
        const requestedView = (location.hash || '#workspace').slice(1);
        this._initPipeline();
        this._setupNav();
        this._setupFormHandlers();
        this._setupGlobalClicks();
        this._updateApiStatus();
        await this._refreshProjects();
        const draft = this._workspaceStore.read(null);
        const storedActive = this._workspaceStore.active();
        const active = (this._projects.some(project => project.project_id === storedActive) ? storedActive : null) || (!draft?.topicType && !draft?.idea ? this._projects.find(project => project.can_resume)?.project_id : null);
        if (active) await this.openProject(active);
        else this._restoreWorkspaceSnapshot(this._workspaceStore.read(null));
        this._navigate(['workspace','my-works','flow','reader'].includes(requestedView) ? requestedView : 'workspace');
        document.getElementById('runtime-log-details').open = window.innerWidth > 1000;
        this.loadDailyRankings();
        this._pollRuntime();
        this._runtimeTimer = setInterval(() => this._pollRuntime(), 3000);
        document.addEventListener('input', e => {
            if (e.target.closest('#workspace-pipeline')) this._rememberWorkspace();
        });
        window.addEventListener('beforeunload', () => this._rememberWorkspace());
    },

    _rememberWorkspace() {
        if (!this._workspaceStore || this._restoringWorkspace) return;
        (this._synopsisCards || []).forEach((card, index) => {
            card.editedTitle = document.getElementById(`synopsis-title-${index}`)?.value ?? card.editedTitle;
            card.editedSynopsis = document.getElementById(`synopsis-desc-${index}`)?.value ?? card.editedSynopsis;
        });
        this._workspaceStore.setActive(this.currentProjectId);
        this._workspaceStore.save(this.currentProjectId, {
            topicType:document.getElementById('topic-type').value,
            sizeWords:document.getElementById('size-words').value, sizeChapters:document.getElementById('size-chapters').value,
            idea:document.getElementById('topic-idea').value,
            inspiration:document.getElementById('topic-inspiration').value,
            source:this._sourceChoice || 'manual', entryVisible:document.getElementById('topic-entry').style.display !== 'none',
            manualEditing:!!this._manualEditing,
            phaseInputs:Object.fromEntries(Array.from(document.querySelectorAll('#workspace-pipeline textarea[id$="inspiration"]')).map(el => [el.id, el.value])),
            rankingsOpen:document.getElementById('daily-rankings').open,
            checked:this._checkedCandidates || {}, cards:this._synopsisCards || [], selected:this._selectedSynopsisIdx,
            results:this._phaseResults || {}, pipeline:this._pipelineState,
        });
    },

    _restoreWorkspaceSnapshot(snapshot) {
        if (!snapshot) return;
        this._restoringWorkspace = true;
        try {
            document.getElementById('topic-type').value = snapshot.topicType || '';
            if (snapshot.sizeWords) document.getElementById('size-words').value = snapshot.sizeWords;
            if (snapshot.sizeChapters) document.getElementById('size-chapters').value = snapshot.sizeChapters;
            this.updateSizeHint();
            document.getElementById('topic-idea').value = snapshot.idea || '';
            document.getElementById('topic-inspiration').value = snapshot.inspiration || '';
            for (const [id, value] of Object.entries(snapshot.phaseInputs || {})) {
                const input = document.getElementById(id); if (input) input.value = value;
            }
            for (const [step, data] of Object.entries(snapshot.results || {})) {
                if (!this._phaseResults?.[step]) this._renderPhaseResult(step, data);
            }
            if (JSON.stringify(snapshot.results?.topic) === JSON.stringify(this._phaseResults?.topic)) {
                for (const [name, checked] of Object.entries(snapshot.checked || {})) {
                    if (checked && !this._checkedCandidates[name]) this.toggleCandidate(name);
                }
                if (snapshot.cards?.length) {
                    this._synopsisCards = snapshot.cards;
                    const cards = document.getElementById('topic-synopsis-cards');
                    cards.innerHTML = snapshot.cards.map((card, index) => this._renderSynopsisCard(card, index)).join('');
                    cards.style.display = 'block';
                    if (snapshot.selected >= 0) this.selectSynopsisCard(snapshot.selected);
                    document.getElementById('topic-confirm-area').style.display = 'flex';
                }
            }
            document.getElementById('daily-rankings').open = !!snapshot.rankingsOpen;
            document.getElementById('topic-entry').style.display = snapshot.entryVisible === false ? 'none' : '';
            this._sourceChoice = snapshot.source || 'manual';
            this._manualEditing = !!snapshot.manualEditing;
            if (this._manualEditing) {
                document.getElementById('topic-entry').style.display = '';
                ['topic-candidates-area','topic-synopsis-cards','topic-confirm-area','topic-ai-area'].forEach(id => { document.getElementById(id).style.display = 'none'; });
            }
            this._updateSourceLabel();
        } finally { this._restoringWorkspace = false; }
    },

    _updateSourceLabel() {
        const source = this._sourceChoice || 'manual';
        document.getElementById('topic-source-label').textContent = source === 'rankings' ? '榜单选题' : '自主创作';
        document.getElementById('btn-return-manual').hidden = source !== 'rankings' && !document.getElementById('daily-rankings').open;
    },

    async returnToManual() {
        this._rememberWorkspace();
        this._workspaceEpoch++;
        if (this.currentProjectId) {
            try { await API.manualTopic(this.currentProjectId); }
            catch (err) {
                if (err.message.includes('后续创作阶段')) {
                    this.newWorkspace();
                    document.getElementById('topic-entry-error').textContent = '已打开自主创作草稿，原项目成果已保留。';
                    return;
                }
                document.getElementById('runtime-message').textContent = `切换失败：${err.message}`;
                return;
            }
        }
        this._sourceChoice = 'manual';
        this._manualEditing = true;
        document.getElementById('daily-rankings').open = false;
        document.getElementById('topic-entry').style.display = '';
        document.getElementById('btn-research-topic').disabled = false;
        ['topic-candidates-area','topic-synopsis-cards','topic-confirm-area','topic-ai-area'].forEach(id => {
            document.getElementById(id).style.display = 'none';
        });
        this._updateSourceLabel();
        this._rememberWorkspace();
        this._pollRuntime();
    },

    async loadDailyRankings() {
        try { this._renderDailyRankings(await API.dailyRankings()); }
        catch (err) { document.getElementById('rankings-message').textContent = `读取失败：${err.message}`; }
    },

    showDailyRankings() {
        this._navigate('workspace');
        const panel = document.getElementById('daily-rankings');
        panel.open = true;
        panel.scrollIntoView({block:'start',behavior:'auto'});
        this._updateSourceLabel();
        this._rememberWorkspace();
        this.loadDailyRankings();
    },

    _renderDailyRankings(data) {
        const labels = {idle:'尚未开始', loading:'正在扫榜', ready:'已完成', partial:'已完成（部分可用）', failed:'扫榜失败'};
        const status = document.getElementById('today-scan-status');
        status.textContent = labels[data.status] || '状态未知';
        status.dataset.status = data.status;
        document.getElementById('today-scan-date').textContent = data.date || '';
        const count = data.book_count ?? Object.values(data.platforms || {}).reduce((n,p) => n + (p.entries?.length || 0), 0);
        document.getElementById('today-topic-status').textContent = data.topic_status === 'loading' ? `今日选题：预生成中，已保存${data.topic_cards?.length || 0}/4张` : data.topic_cards?.length ? `今日选题：已缓存${data.topic_cards.length}张，可直接使用` : data.topic_status === 'failed' ? '今日选题：准备失败，可单独重试' : '今日选题：等待后台准备';
        document.getElementById('today-scan-message').textContent = data.status === 'loading'
            ? (data.stage === 'analyzing' ? '正在解析榜单，请稍候' : '正在抓取榜单，请稍候')
            : data.status === 'failed' ? data.message || '扫榜失败，可重试'
            : `${count} 本书已缓存${data.errors?.length ? '；' + data.errors.join('；') : ''}${data.attempt_error ? '；本次刷新失败，仍保留上次结果' : ''}`;
        const seconds = data.started_at ? Math.max(0, Math.floor((Date.now() - new Date(data.started_at))/1000)) : 0;
        document.getElementById('today-scan-time').textContent = data.status === 'loading'
            ? `已用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
            : data.updated_at ? `${data.status === 'failed' ? '结束' : '完成'}时间 ${new Date(data.updated_at).toLocaleTimeString('zh-CN')}` : '每日自动更新';
        document.getElementById('today-scan-retry').disabled = data.status === 'loading';
        const signature = JSON.stringify([data.date,data.updated_at,data.status,data.message,data.topic_status,data.topic_message,data.topic_cards?.length]);
        if (signature === this._rankingsSignature) return;
        this._rankingsSignature = signature;
        document.getElementById('rankings-date').textContent = data.date || '';
        document.getElementById('rankings-message').textContent = data.message || '';
        const ready = ['ready', 'partial'].includes(data.status);
        document.getElementById('btn-use-rankings').disabled = !ready || !data.topic_cards?.length;
        document.getElementById('prepared-topics-status').textContent = data.topic_message || '榜单完成后将预生成题材、书名与简介，保存后所有项目可复用。';
        document.getElementById('retry-prepared-topics').disabled = data.topic_status === 'loading' || !ready;
        document.getElementById('prepared-topics-cards').innerHTML = (data.topic_cards || []).map(card => `<article class="prepared-topic-card"><h4>${this._esc(card.title)}</h4><p class="muted">${this._esc(card.genre_name)}</p><p>${this._esc(card.synopsis)}</p></article>`).join('');
        document.getElementById('btn-refresh-rankings').disabled = data.status === 'loading';
        const topics = document.getElementById('rankings-topics');
        topics.replaceChildren();
        (data.topics || []).forEach(topic => {
            const button = document.createElement('button');
            button.className = 'ranking-topic';
            button.textContent = `${topic.name} · ${topic.count} 本`;
            button.onclick = () => { document.getElementById('topic-type').value = topic.name; };
            topics.appendChild(button);
        });
        const books = document.getElementById('rankings-books');
        books.replaceChildren();
        Object.values(data.platforms || {}).forEach(platform => {
            const block = document.createElement('div'); block.className = 'ranking-books';
            const title = document.createElement('strong');
            title.textContent = `${platform.platform || '榜单'} · ${platform.entries?.length || 0} 本`;
            block.appendChild(title);
            const list = document.createElement('ul');
            (platform.entries || []).forEach(book => {
                const item = document.createElement('li');
                const details = document.createElement('details');
                const summary = document.createElement('summary'); summary.textContent = `${book.rank ? book.rank + '. ' : ''}${book.title}${book.genre ? ' · ' + book.genre : ''}`;
                details.appendChild(summary);
                Object.entries(book).filter(([key,value]) => !['title','rank','genre'].includes(key) && value !== '' && value !== null && value !== undefined).forEach(([key,value]) => {
                    const line = document.createElement('p');
                    line.textContent = `${({author:'作者',intro:'简介',hook:'卖点',core_hook:'核心卖点',one_liner:'一句话简介',title_appeal:'书名吸引力',golden_finger:'核心设定',opening_pressure:'开篇冲突',pleasure_loop:'爽点循环',tomato_adaptable:'是否标记为番茄适配',status:'状态',word_count:'字数',url:'来源',brief:'内容简介',why_popular:'流行原因'})[key] || key}：${typeof value === 'boolean' ? (value ? '是' : '未标记') : typeof value === 'object' ? JSON.stringify(value) : value}`;
                    details.appendChild(line);
                });
                item.appendChild(details);
                list.appendChild(item);
            });
            block.appendChild(list); books.appendChild(block);
        });
    },

    async refreshDailyRankings() {
        const button = document.getElementById('btn-refresh-rankings');
        button.disabled = true;
        try {
            await API.refreshRankings();
            document.getElementById('rankings-message').textContent = '已提交后台重试，请在右侧查看进度。';
        } catch (err) {
            document.getElementById('rankings-message').textContent = err.message;
        } finally { setTimeout(() => this.loadDailyRankings(), 500); }
    },

    async retryPreparedTopics() {
        try { await API.retryPreparedTopics(); document.getElementById('prepared-topics-status').textContent = '已提交选题预生成重试，不会重新扫榜。'; }
        catch (error) { document.getElementById('prepared-topics-status').textContent = error.message; }
    },

    applySizePreset() {
        const preset = document.getElementById('size-preset').value;
        if (preset !== 'custom') {
            const [words,chapters] = preset.split(':');
            document.getElementById('size-words').value = words; document.getElementById('size-chapters').value = chapters;
        }
        this.updateSizeHint(); this._rememberWorkspace();
    },

    getStorySize() {
        const words = Number(document.getElementById('size-words').value), chapters = Number(document.getElementById('size-chapters').value);
        if (!Number.isInteger(words) || !Number.isInteger(chapters) || words < 1000 || words > 500000 || chapters < 1 || chapters > 200 || words < chapters * 300) throw Error('总字数需为1000至500000，章节数1至200，平均每章至少300字。');
        return {target_word_count:words,target_chapter_count:chapters};
    },

    updateSizeHint() {
        try {
            const size = this.getStorySize();
            document.getElementById('size-hint').textContent = `全书约${size.target_word_count.toLocaleString()}字 / ${size.target_chapter_count}章，平均每章约${Math.round(size.target_word_count/size.target_chapter_count)}字。`;
            const key = `${size.target_word_count}:${size.target_chapter_count}`;
            document.getElementById('size-preset').value = ['10000:10','5000:5','20000:20'].includes(key) ? key : 'custom';
        } catch (error) { document.getElementById('size-hint').textContent = error.message; }
    },

    async _pollRuntime() {
        if (this._runtimePolling) return;
        this._runtimePolling = true;
        const projectId = this.currentProjectId;
        const epoch = this._workspaceEpoch;
        try {
            const data = await API.runtime(projectId);
            this._renderDailyRankings(data.rankings);
            if (projectId !== this.currentProjectId || epoch !== this._workspaceEpoch) return;
            const connection = document.getElementById('runtime-connection');
            connection.textContent = '服务在线'; connection.className = 'runtime-pill online';
            this._renderDailyRankings(data.rankings);
            const states = { idle:'就绪', editing:'自主创作', paused:'已保存，可继续', running:'执行中', waiting:'等待确认', failed:'执行失败', completed:'已完成' };
            const phases = { topic_selection:'选题研究', mini_arc_outline:'小事件大纲', bible_construction:'世界观构建', character_creation:'角色创建', master_outline:'总体大纲', chapter_planning:'章节规划', chapter_writing:'章节写作', quality_review:'质量审核', polish_revision:'润色修订', memory_update:'记忆更新' };
            const task = data.project || {};
            this._flowRuntime = data;
            this.renderFlow();
            if (document.getElementById('view-reader').classList.contains('active')) this.refreshReader();
            const busy = ['running', 'waiting'].includes(task.status);
            document.getElementById('btn-research-topic').disabled = busy;
            document.getElementById('btn-use-rankings').disabled = busy || !['ready','partial'].includes(data.rankings.status) || !data.rankings.topic_cards?.length;
            if (busy) document.getElementById('topic-entry').style.display = 'none';
            else if (task.status === 'editing') document.getElementById('topic-entry').style.display = '';
            const stage = phases[task.phase] || '';
            document.getElementById('runtime-stage').textContent = `${stage}${stage ? ' · ' : ''}${states[task.status] || task.status || '就绪'}`;
            document.querySelector('.runtime-summary').dataset.status = task.status;
            document.getElementById('runtime-message').textContent = (task.status === 'running' && task.detail) || task.message || '尚未启动创作任务';
            document.getElementById('runtime-updated').textContent = task.updated_at ? new Date(task.updated_at).toLocaleTimeString('zh-CN') : '—';
            const seconds = task.started_at ? Math.max(0, Math.floor((new Date(task.status === 'running' ? data.server_time : task.updated_at) - new Date(task.started_at)) / 1000)) : 0;
            document.getElementById('runtime-elapsed').textContent = task.started_at ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : '—';
            document.getElementById('runtime-rankings').textContent = ({ready:'已缓存', partial:'部分可用', failed:'失败，可手动选题', loading:'后台准备中', idle:'待准备'})[data.rankings.status] || '—';
            const warning = document.getElementById('runtime-warning');
            warning.hidden = !(task.status === 'running' && seconds >= 60);
            warning.textContent = '模型等待时间较长。请查看下方记录；服务心跳正常不代表模型已生成内容。';
            const resume = document.getElementById('btn-retry-task');
            resume.hidden = !projectId || !(['failed','paused'].includes(task.status) || (task.status === 'waiting' && task.needs_resume));
            resume.textContent = task.status === 'waiting' ? '恢复到待确认阶段' : '继续上次生成';
            document.getElementById('btn-pause-task').hidden = !projectId || !['running','waiting','failed'].includes(task.status);
            const step = ({topic_selection:'topic', mini_arc_outline:'arc', bible_construction:'bible', character_creation:'chars', master_outline:'outline'})[task.phase] || 'write';
            if (task.status === 'paused' && projectId) this._updatePipelineBadge(step, 'paused');
            if (task.status === 'failed') {
                if (task.phase === 'topic_selection') document.getElementById('topic-entry').style.display = '';
                Object.keys(this._pipelineState).filter(s => this._pipelineState[s] === 'running').forEach(s => this._updatePipelineBadge(s, 'failed'));
                if (projectId) this._updatePipelineBadge(step, 'failed');
                document.getElementById('btn-research-topic').disabled = false;
            }
            if (projectId && task.status === 'waiting' && data.phase_data) {
                const key = `${projectId}:${task.phase}:${JSON.stringify(data.phase_data)}`;
                if (key !== this._restoredPhaseKey) {
                    this._restoredPhaseKey = key;
                    this._renderPhaseResult(step, data.phase_data);
                    this._updatePipelineBadge(step, 'done');
                    const confirm = document.getElementById(`${step}-confirm-area`);
                    if (confirm) confirm.style.display = 'flex';
                }
            }
            const taskKey = `${projectId}:${task.status}:${task.phase}`;
            if (taskKey !== this._lastTaskKey) { this._lastTaskKey = taskKey; this._rememberWorkspace(); }
            const eventKey = `${projectId}:${data.events?.at(-1)?.id || 0}`;
            if (eventKey !== this._runtimeEventKey) {
                this._runtimeEventKey = eventKey;
                const events = document.getElementById('runtime-events'); events.replaceChildren();
                (data.events || []).slice().reverse().forEach(event => {
                    const item = document.createElement('li'); item.className = event.level;
                    const time = document.createElement('time'); time.textContent = new Date(event.time).toLocaleTimeString('zh-CN');
                    const text = document.createElement('span'); text.textContent = event.message;
                    item.append(time, text); events.appendChild(item);
                });
                if (!data.events?.length) { const item = document.createElement('li'); item.textContent = '暂无运行记录'; events.appendChild(item); }
            }
        } catch (err) {
            document.getElementById('flow-connection').textContent = '连接中断';
            document.getElementById('flow-connection').className = 'runtime-pill offline';
            document.getElementById('today-scan-status').textContent = '暂时无法读取';
            const connection = document.getElementById('runtime-connection');
            connection.textContent = '连接中断'; connection.className = 'runtime-pill offline';
            document.getElementById('runtime-message').textContent = `无法读取后台状态：${err.message}。请检查服务是否已启动。`;
        } finally { this._runtimePolling = false; }
    },

    async retryFailedTask() {
        return this.resumeGeneration();
    },

    async resumeGeneration() {
        if (!this.currentProjectId) return;
        this._rememberWorkspace();
        const button = document.getElementById('btn-retry-task'); button.disabled = true;
        try { await API.resumeGeneration(this.currentProjectId); }
        catch (err) { document.getElementById('runtime-message').textContent = `继续失败：${err.message}`; }
        finally { button.disabled = false; }
        this._workspaceEpoch++;
        this._pollRuntime();
    },

    async pauseGeneration() {
        if (!this.currentProjectId) return;
        this._rememberWorkspace();
        const button = document.getElementById('btn-pause-task'); button.disabled = true;
        try {
            await API.pauseGeneration(this.currentProjectId);
            this._workspaceEpoch++;
            document.getElementById('runtime-message').textContent = '进度和记录已保存，可以退出；下次点击继续上次生成。';
        } catch (err) { document.getElementById('runtime-message').textContent = `保存失败：${err.message}`; }
        finally { button.disabled = false; }
        this._pollRuntime();
    },

    async startTopicResearch(source) {
        const button = document.getElementById('btn-research-topic');
        if (button.disabled) return;
        const type = document.getElementById('topic-type').value.trim();
        const idea = document.getElementById('topic-idea').value.trim();
        const error = document.getElementById('topic-entry-error'); error.textContent = '';
        if (source === 'manual' && !type && !idea) { error.textContent = '请填写题材类型或故事灵感。'; return; }
        button.disabled = true;
        this._rememberWorkspace();
        this._sourceChoice = source;
        this._manualEditing = false;
        this._workspaceEpoch++;
        this._updateSourceLabel();
        try {
            const size = this.getStorySize();
            if (!this.currentProjectId) {
                const result = await API.createProject({title:'未命名项目', inspiration:idea || type || '参考今日榜单', genre:[type || '待选题'], target_readers:'网文读者',...size});
                this.currentProjectId = result.project_id;
                this._workspaceStore?.setActive(this.currentProjectId);
                await this._refreshProjects();
                this._initPipeline(); this._showProjectHeader('未命名项目');
                this._connectWS(result.project_id);
            }
            await API.startWorkflow(this.currentProjectId, {topic_source:source, topic_type:type, inspiration:idea || type || '参考今日榜单',...size});
            document.getElementById('topic-entry').style.display = 'none';
            this._updatePipelineBadge('topic', 'running');
            this._rememberWorkspace();
            this._pollRuntime();
        } catch (err) {
            error.textContent = `启动失败：${err.message}`;
            this._updatePipelineBadge('topic', 'failed');
        } finally { button.disabled = false; }
    },

    _setupGlobalClicks() {
        // Event delegation for project cards
        const cardsEl = document.getElementById('my-works-cards');
        if (cardsEl) {
            cardsEl.addEventListener('click', (e) => {
                const button = e.target.closest('button[data-book-action]');
                const card = button?.closest('[data-project-id]');
                if (!card) return;
                const id = card.dataset.projectId;
                if (button.dataset.bookAction === 'continue') this.continueBook(id);
                if (button.dataset.bookAction === 'title') this.editBookTitle(id);
                if (button.dataset.bookAction === 'delete') this.deleteBook(id);
                if (button.dataset.bookAction === 'content') this.editBookContent(id);
                if (button.dataset.bookAction === 'preview') this.previewBook(id);
            });
        }
    },

    // ================================================================
    // Navigation
    // ================================================================
    _setupNav() {
        window.addEventListener('hashchange', () => this._route());
        ['nav-workspace','nav-my-works','nav-flow','nav-reader'].forEach(id => {
            document.getElementById(id).addEventListener('click', (e) => {
                e.preventDefault();
                const v = id.replace('nav-','');
                this._rememberWorkspace();
                this._navigate(v);
            });
        });
    },

    _navigate(viewName) {
        if (!['workspace','my-works','project','flow','reader'].includes(viewName)) viewName = 'workspace';
        this._rememberWorkspace();
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('#nav .nav-item').forEach(n => n.classList.remove('active'));
        const el = document.getElementById(`view-${viewName}`);
        if (el) el.classList.add('active');
        const navId = viewName === 'project' ? 'nav-my-works' : `nav-${viewName}`;
        const nav = document.getElementById(navId);
        if (nav) nav.classList.add('active');
        // Use replaceState to avoid triggering hashchange again
        if (window.location.hash !== `#${viewName}`) {
            history.replaceState(null, '', `#${viewName}`);
        }
        if (viewName === 'my-works') { this._renderProjectList(); this._refreshProjects().then(() => this._renderProjectList()); }
        if (viewName === 'project' && this.currentProjectId) this._detailPromise = this._loadProjectDetail();
        if (viewName === 'flow') { this.renderFlow(); this._pollRuntime(); }
        if (viewName === 'reader') this.refreshReader();
        // Show/hide workspace header based on active project
        if (viewName === 'workspace') {
            if (this.currentProjectId) {
                // Project is loaded — keep header as is (set by openProject or startScan)
            } else {
                // No project — show default title, hide project header
                document.getElementById('workspace-default-title').style.display = '';
                document.getElementById('workspace-project-header').style.display = 'none';
            }
        }
    },

    _route() {
        const v = (window.location.hash || '#workspace').replace('#','');
        if (v === 'project') {
            if (this.currentProjectId) { this._navigate('project'); }
            else { this._navigate('my-works'); }
        } else {
            this._navigate(v);
        }
    },

    // ================================================================
    // 我的书库 — 纯项目列表
    // ================================================================
    async _refreshProjects() {
        try { this._projects = await API.listProjects() || []; }
        catch (err) { console.error(err); }
    },

    _renderProjectList() {
        const container = document.getElementById('my-works-cards');
        if (!container) return;
        if (!this._projects.length) {
            container.innerHTML = '<p class="empty-state">暂无项目，前往<a href="#workspace">工作台</a>开始创作</p>';
            return;
        }
        container.innerHTML = this._projects.map(p => {
            const badge = p.current_chapter && p.total_chapters ? `${p.current_chapter}/${p.total_chapters}章` : '';
            const status = AgentFlow.STATUS[p.status] || '尚未开始';
            const phase = AgentFlow.STAGES.find(stage => stage.phase === p.resume_phase)?.title || '待开始';
            return `<article class="card library-book" data-project-id="${this._esc(p.project_id)}">
                <div class="book-heading"><span class="book-mark" aria-hidden="true">文</span><span class="status">${status}</span></div>
                <h3><button class="book-title-link" data-book-action="continue">${this._esc(p.title || '未命名')}</button></h3>
                <p class="meta">${phase} · ${badge || '尚无已完成章节'}</p>
                <p class="book-updated">最近保存 ${p.updated_at ? this._esc(new Date(p.updated_at).toLocaleString('zh-CN')) : '暂无'}</p>
                <div class="book-actions"><button class="btn btn-primary" data-book-action="continue">${p.status === 'completed' ? '查看创作' : '继续创作'}</button><button class="btn btn-secondary" data-book-action="preview">预览正文</button><button class="btn btn-secondary" data-book-action="content">编辑内容</button></div>
                <div class="book-secondary"><button class="text-button" data-book-action="title">编辑书名</button><button class="text-button danger-text" data-book-action="delete">删除记录</button></div>
            </article>`;
        }).join('');
    },

    async continueBook(id) {
        if (!id || this._openingBook) return;
        this._openingBook = true;
        try {
            await this.openProject(id);
            const workspace = await API.getWorkspace(id);
            // Opening a book restores its confirmation UI; only paused/failed work needs a resume call.
            if (['failed','paused'].includes(workspace.runtime.status) || (workspace.runtime.status === 'waiting' && workspace.runtime.needs_resume)) {
                await this.resumeGeneration();
            }
        } catch (err) {
            document.getElementById('runtime-message').textContent = `恢复失败：${err.message}`;
        } finally { this._openingBook = false; }
    },

    async editBookContent(id) {
        await this.openProject(id);
        this._navigate('project');
        await this._detailPromise;
        this._switchTab('chapters');
    },

    editBookTitle(id) {
        this._editingBookId = id;
        document.getElementById('book-title-input').value = this._projects.find(p => p.project_id === id)?.title || '';
        document.getElementById('book-title-error').textContent = '';
        document.getElementById('book-title-dialog').showModal();
    },

    async saveBookTitle() {
        const input = document.getElementById('book-title-input');
        if (!input.value.trim()) { document.getElementById('book-title-error').textContent = '请输入书名'; return; }
        const button = document.getElementById('book-title-save'); button.disabled = true;
        try {
            await API.updateTitle(this._editingBookId, input.value.trim());
            if (this.currentProjectId === this._editingBookId) this._showProjectHeader(input.value.trim());
            await this._refreshProjects(); this._renderProjectList(); this.renderFlow();
            document.getElementById('book-title-dialog').close();
        } catch (err) { document.getElementById('book-title-error').textContent = err.message; }
        finally { button.disabled = false; }
    },

    deleteBook(id) {
        this._deletingBookId = id;
        document.getElementById('book-delete-name').textContent = `《${this._projects.find(p => p.project_id === id)?.title || '未命名'}》`;
        document.getElementById('book-delete-error').textContent = '';
        document.getElementById('book-delete-dialog').showModal();
    },

    async confirmDeleteBook() {
        const id = this._deletingBookId;
        const button = document.getElementById('book-delete-confirm'); button.disabled = true;
        try {
            const result = await API.deleteProject(id);
            this._lastDeletedBook = {id, archiveId:result.archive_id};
            if (this.currentProjectId === id) {
                this.newWorkspace();
                this._flowRuntime = null; this._flowFrozen = false;
            }
            this._workspaceStore?.remove(id);
            await this._refreshProjects(); this._renderProjectList();
            document.getElementById('book-delete-dialog').close();
            this._navigate('my-works');
            const notice = document.getElementById('library-notice'); notice.hidden = false;
            notice.innerHTML = '记录已移入本地回收目录。<button class="text-button" onclick="App.undoDeleteBook()">撤销删除</button>';
        } catch (err) { document.getElementById('book-delete-error').textContent = err.message; }
        finally { button.disabled = false; }
    },

    async undoDeleteBook() {
        if (!this._lastDeletedBook) return;
        const notice = document.getElementById('library-notice');
        try {
            await API.restoreProject(this._lastDeletedBook.archiveId);
            this._lastDeletedBook = null;
            await this._refreshProjects(); this._renderProjectList();
            notice.textContent = '记录已恢复，生成进度和日志均已保留。';
        } catch (err) { notice.textContent = `恢复失败：${err.message}`; }
    },

    async selectFlowProject(id) {
        if (id) await this.openProject(id);
        this._navigate('flow');
    },

    toggleFlowRefresh() {
        this._flowFrozen = !this._flowFrozen;
        document.getElementById('flow-freeze').textContent = this._flowFrozen ? '恢复刷新' : '暂停刷新';
        this.renderFlow();
    },

    renderFlow() {
        if (typeof AgentFlow === 'undefined') return;
        AgentFlow.render(this);
    },

    refreshReader() { return ChapterReader.refresh(this); },

    async previewBook(id) { await this.openProject(id); this._navigate('reader'); },

    async selectReaderProject(id) {
        if (id) await this.openProject(id);
        this._navigate('reader');
    },

    async openProject(id) {
        this._rememberWorkspace();
        this._workspaceEpoch++;
        const local = this._workspaceStore?.read(id);
        this.currentProjectId = id;
        this._flowRuntime = null; this._flowFrozen = false;
        this._workspaceStore?.setActive(id);
        this._workflowDone = false;
        this._connectWS(id);
        this._initPipeline();
        try {
            const p = await API.getWorkspace(id);
            const title = p.config?.title || '未命名';
            this._showProjectHeader(title);
            document.getElementById('size-words').value = p.config.target_word_count;
            document.getElementById('size-chapters').value = p.config.target_chapter_count || p.results?.master_outline?.chapter_count || 20;
            document.getElementById('story-size').disabled = !['idle','topic_selection'].includes(p.runtime?.phase);
            this.updateSizeHint();
            this._sourceChoice = p.config.topic_source || 'manual';
            document.getElementById('topic-type').value = p.config.topic_type || '';
            document.getElementById('topic-idea').value = p.config.inspiration === '参考今日榜单' ? '' : p.config.inspiration || '';
            for (const [phase, data] of Object.entries(p.results || {})) {
                const step = ({topic_selection:'topic',mini_arc_outline:'arc',bible_construction:'bible',character_creation:'chars',master_outline:'outline'})[phase];
                if (step) { this._renderPhaseResult(step, data); this._updatePipelineBadge(step, data.complete === false ? 'paused' : 'done'); }
            }
            if (p.runtime?.status === 'waiting') {
                const step = ({topic_selection:'topic',mini_arc_outline:'arc',bible_construction:'bible',character_creation:'chars',master_outline:'outline'})[p.runtime.phase];
                const confirm = document.getElementById(`${step}-confirm-area`);
                if (confirm) confirm.style.display = 'flex';
                this._restoredPhaseKey = `${id}:${p.runtime.phase}:${JSON.stringify(p.results[p.runtime.phase])}`;
            }
            document.getElementById('topic-entry').style.display = ['running','waiting','paused'].includes(p.runtime?.status) || !['idle','topic_selection'].includes(p.runtime?.phase) ? 'none' : '';
        } catch(e) { document.getElementById('runtime-message').textContent = `恢复项目失败：${e.message}`; }
        this._restoreWorkspaceSnapshot(local);
        this._updateSourceLabel();
        this._navigate('workspace');
        this._pollRuntime();
    },

    newWorkspace() {
        this._rememberWorkspace();
        this._workspaceEpoch++;
        this.currentProjectId = null;
        document.getElementById('story-size').disabled = false;
        document.getElementById('size-words').value = 10000; document.getElementById('size-chapters').value = 10;
        this.updateSizeHint();
        this._flowRuntime = null; this._flowFrozen = false;
        this._workspaceStore?.setActive(null);
        this._initPipeline();
        this._sourceChoice = 'manual';
        this._manualEditing = false;
        if (this.ws) { this.ws.close(); this.ws = null; }
        document.getElementById('topic-type').value = '';
        document.getElementById('topic-idea').value = '';
        document.getElementById('topic-entry-error').textContent = '';
        document.getElementById('topic-inspiration').value = '';
        document.querySelectorAll('#workspace-pipeline textarea[id$="inspiration"]').forEach(el => { el.value = ''; });
        document.getElementById('daily-rankings').open = false;
        this._updateSourceLabel();
        this._navigate('workspace');
        this._pollRuntime();
    },

    async _loadProjectDetail() {
        if (!this.currentProjectId) return;
        try {
            const p = await API.getProject(this.currentProjectId);
            document.getElementById('project-title').textContent = p.config.title || '未命名';
            document.getElementById('overview-content').innerHTML = Components.overviewEditable(p);
            // Detect if already complete
            const tc = p.meta?.total_chapters || 0;
            const cc = p.meta?.current_chapter || 0;
            if (tc > 0 && cc >= tc) this._workflowDone = true;
            this._setupTabs();
        } catch (err) { console.error(err); }
    },

    // ================================================================
    // Tabs
    // ================================================================
    _setupTabs() {
        document.querySelectorAll('#view-project .tab').forEach(tab => {
            tab.onclick = async () => {
                document.querySelectorAll('#view-project .tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('#view-project .tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active');
                await this._loadTabContent(tab.dataset.tab);
            };
        });
    },

    async _loadTabContent(tab) {
        if (!this.currentProjectId) return;
        try {
            if (tab === 'topics') { document.getElementById('topics-content').innerHTML = Components.topicResearchView(); }
            else if (tab === 'bible') { const d = await API.getBible(this.currentProjectId); document.getElementById('bible-content').innerHTML = Components.bibleEditable(d); }
            else if (tab === 'characters') { const d = await API.getCharacters(this.currentProjectId); document.getElementById('characters-content').innerHTML = Components.charactersEditable(d); }
            else if (tab === 'outline') { const d = await API.getOutline(this.currentProjectId); document.getElementById('outline-content').innerHTML = Components.outlineEditable(d); }
            else if (tab === 'chapters') { const d = await API.getChapters(this.currentProjectId); let tc = 0; try { const p = await API.getProject(this.currentProjectId); tc = p.meta?.total_chapters || 0; } catch(e){} const allDone = this._workflowDone || (Array.isArray(d) && d.length > 0 && d.every(c => c.status === 'done')); document.getElementById('chapters-content').innerHTML = Components.chaptersView(d, {workflowDone: allDone, totalChapters: tc}); }
        } catch (err) { if (!err.message?.includes('404')) console.error(err); }
    },

    async viewChapter(num) {
        try {
            const ch = await API.getChapter(this.currentProjectId, num);
            const cn = Components._CN_NUM[num] || num;
            let html = `<h3>第${cn}章 ${Components._esc(ch.plan?.title||ch.title||'')}</h3>`;
            // Show status
            const statusLabels = { planned:'已规划', writing:'写作中', reviewing:'审核中', polishing:'润色中', done:'已完成' };
            if (ch.status) html += `<p>状态：${statusLabels[ch.status]||ch.status}</p>`;
            // Show review if available
            if (ch.review) html += Components.reviewScores(ch.review.dimension_scores);
            if (ch.review?.issues) html += Components.issuesList(ch.review.issues);
            html += '<hr style="margin:16px 0;border-color:var(--border)">';
            // Show content or explain what's missing
            if (ch.content) {
                let cleanContent = ch.content.replace(/^#{1,4}\s+.+$/gm, '');
                cleanContent = cleanContent.replace(/\n{3,}/g, '\n\n').trim();
                html += `<div style="display:flex;align-items:center;gap:8px;margin-top:12px"><strong>正文</strong><button class="btn btn-secondary btn-sm" onclick="App.toggleChapterEdit(${num})">编辑</button></div>`;
                html += `<div id="chapter-display-${num}" style="white-space:pre-wrap;line-height:2;font-size:1rem;margin-top:8px">${Components._esc(cleanContent)}</div>`;
                html += `<div id="chapter-editor-${num}" style="display:none"><textarea id="chapter-textarea-${num}" style="width:100%;min-height:300px;padding:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:inherit;font-size:0.95rem;line-height:1.8;resize:vertical">${Components._esc(cleanContent)}</textarea><button class="btn btn-success btn-sm" onclick="App.saveChapterEdit(${num})" style="margin-top:8px">保存</button></div>`;
            } else if (ch.draft?.content) {
                html += `<p class="muted">已保存的初稿，尚未完成审核与润色。</p><div style="white-space:pre-wrap;line-height:2">${Components._esc(ch.draft.content)}</div>`;
            } else if (ch.plan) {
                html += `<p style="color:var(--text-secondary)">章节已规划，内容尚未生成。</p>`;
                if (ch.plan.goal) html += `<p><strong>本章目标：</strong>${Components._esc(ch.plan.goal)}</p>`;
                if (ch.plan.scenes?.length) {
                    const sceneTexts = ch.plan.scenes.map(s => {
                        if (typeof s === 'string') {
                            // Clean raw markers: 【xxx】text（POV → just text
                            let t = s.replace(/【[^】]+】/g, '').replace(/（POV.*?）|\(POV.*?\)/g, '').replace(/→/g, '').trim();
                            return Components._esc(t.substring(0, 80));
                        }
                        return Components._esc((s.setting || s.goal || '').substring(0, 80));
                    }).filter(Boolean);
                    if (sceneTexts.length) html += `<p><strong>场景：</strong>${sceneTexts.join(' → ')}</p>`;
                }
                html += `<button class="btn btn-primary btn-sm" onclick="App.startWorkflow()" style="margin-top:8px">继续生成</button>`;
            } else {
                html += '<p style="color:var(--text-secondary)">该章节尚未生成。点击「继续生成」开始写作。</p>';
            }
            if (ch.content) {
                html += `<div style="margin-top:16px"><a href="${API.getChapterMdUrl(this.currentProjectId, num)}" class="btn btn-secondary btn-sm">下载 Markdown</a></div>`;
            }
            document.getElementById('chapter-modal-body').innerHTML = html;
            document.getElementById('chapter-modal').classList.add('active');
            document.querySelector('.modal-close').onclick = () => document.getElementById('chapter-modal').classList.remove('active');
            document.getElementById('chapter-modal').onclick = (e) => { if (e.target === document.getElementById('chapter-modal')) document.getElementById('chapter-modal').classList.remove('active'); };
        } catch (err) { alert(`加载失败: ${err.message}`); }
    },

    exportDocx() { if (this.currentProjectId) window.open(API.getExportDocxUrl(this.currentProjectId)); },
    exportMarkdown() { if (this.currentProjectId) window.open(API.getExportMdUrl(this.currentProjectId)); },

    // ================================================================
    // Inline Edit — generic toggle for any section
    // ================================================================
    toggleEdit(sectionId) {
        const display = document.getElementById(`${sectionId}-display`);
        const editor = document.getElementById(`${sectionId}-editor`);
        const btn = document.getElementById(`${sectionId}-edit-btn`);
        if (!display || !editor) return;
        const editing = editor.style.display !== 'none';
        if (editing) {
            const textarea = editor.querySelector('textarea');
            if (textarea) {
                const newValue = textarea.value;
                // Keep same font: update display with pre-wrap to match textarea
                display.innerHTML = `<div style="white-space:pre-wrap;font-family:inherit;font-size:0.95rem;line-height:1.7">${Components._esc(newValue)}</div>`;
                // Save to backend
                this._saveEdit(sectionId, newValue);
            }
            editor.style.display = 'none'; display.style.display = '';
            btn.textContent = '编辑';
        } else {
            const textarea = editor.querySelector('textarea');
            if (textarea) textarea.value = display.innerText;
            editor.style.display = ''; display.style.display = 'none';
            btn.textContent = '保存';
        }
    },

    async _saveEdit(sectionId, value) {
        if (!this.currentProjectId) return;
        try {
            // Determine artifact type from section ID prefix
            if (sectionId.startsWith('bible-')) {
                await API.updateBibleSection(this.currentProjectId, sectionId, value);
            } else if (sectionId.startsWith('char-')) {
                await API.updateCharacterSection(this.currentProjectId, sectionId, value);
            } else if (sectionId.startsWith('outline-')) {
                await API.updateOutlineSection(this.currentProjectId, sectionId, value);
            }
            document.getElementById('phase-label').textContent = '已保存 ✓';
            setTimeout(() => {
                const pl = document.getElementById('phase-label');
                if (pl && pl.textContent === '已保存 ✓') pl.textContent = '就绪';
            }, 2000);
        } catch (err) {
            alert(`保存失败: ${err.message}`);
        }
    },

    // ================================================================
    // Workflow
    // ================================================================
    async startWorkflow() {
        if (!this.currentProjectId) return;
        try {
            await API.startWorkflow(this.currentProjectId);
            document.getElementById('phase-label').textContent = '启动中...';
            document.getElementById('progress-fill').style.width = '2%';
        } catch (err) { alert(`启动失败: ${err.message}`); }
    },

    async confirmPhase() {
        if (!this.currentProjectId) return;
        const insp = document.getElementById('inspiration-input')?.value || '';
        try {
            await API.confirmPhase(this.currentProjectId, insp || null);
            document.querySelector('.phase-confirm')?.remove();
            document.getElementById('phase-label').textContent = '运行中...';
            document.getElementById('progress-fill').style.width = '5%';
        } catch (err) { alert(`确认失败: ${err.message}`); }
    },

    async submitScan() {
        if (!this.currentProjectId) return;
        const feiluHtml = document.getElementById('scan-feilu')?.value || '';
        const fanqieHtml = document.getElementById('scan-fanqie')?.value || '';
        if (!feiluHtml && !fanqieHtml) { alert('请至少粘贴一个平台的榜单页面内容'); return; }
        try {
            this._updatePipelineBadge('scan', 'running');
            document.getElementById('scan-input-area').style.display = 'none';
            document.getElementById('btn-start-scan').style.display = 'none';
            await API.submitScan(this.currentProjectId, feiluHtml || null, fanqieHtml || null);
            await API.startWorkflow(this.currentProjectId);
        } catch (err) { alert(`提交失败: ${err.message}`); }
    },

    /** Skip scan and go directly to bible construction */
    async skipScan() {
        if (!this.currentProjectId) return;
        this._updatePipelineBadge('scan', 'done');
        this._updatePipelineBadge('bible', 'active');
        try { await API.startWorkflow(this.currentProjectId); }
        catch (err) { alert(`启动失败: ${err.message}`); }
    },

    /** Initialize pipeline — first step is scan with "开始扫榜" button */
    _initPipeline() {
        this._phaseResults = {};
        this._checkedCandidates = {};
        this._synopsisCards = [];
        this._selectedSynopsisIdx = -1;
        this._restoredPhaseKey = null;
        document.getElementById('topic-entry').style.display = '';
        const steps = ['scan','topic','arc','bible','chars','outline','write'];
        steps.forEach(s => this._updatePipelineBadge(s, 'pending'));
        this._updatePipelineBadge('topic', 'active');
        // Show start button, hide everything else
        const btnStart = document.getElementById('btn-start-scan');
        if (btnStart) btnStart.style.display = '';
        const scanInput = document.getElementById('scan-input-area');
        if (scanInput) scanInput.style.display = 'none';
        ['scan-result-area','topic-candidates-area','topic-synopsis-cards','topic-ai-area',
         'topic-confirm-area','arc-result-area','arc-confirm-area',
         'bible-result-area','bible-confirm-area','chars-result-area','chars-confirm-area',
         'outline-result-area','outline-confirm-area','write-result-area'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
    },

    /** Update a pipeline step badge */
    _updatePipelineBadge(step, status) {
        this._pipelineState[step] = status;
        const stepEl = document.getElementById(`pipeline-step-${step}`);
        const badgeEl = document.getElementById(`badge-${step}`);
        if (stepEl) {
            stepEl.classList.remove('active','done','running','failed');
            if (status === 'active' || status === 'running') stepEl.classList.add(status);
            else if (status === 'done') stepEl.classList.add('done');
            else if (status === 'failed') stepEl.classList.add('failed');
        }
        if (badgeEl) {
            const labels = { scan:'平台扫榜', topic:'选题研究', arc:'小事件大纲', bible:'世界观构建', chars:'角色创建', outline:'大纲生成', write:'章节写作' };
            const statusLabels = { pending:'待执行', active:'当前步骤', paused:'已保存，可继续', running:'执行中...', done:'已完成 ✓', failed:'执行失败' };
            badgeEl.textContent = statusLabels[status] || status;
            badgeEl.className = 'pipeline-badge ' + (['done','running','active','failed','paused'].includes(status) ? status : '');
        }
    },

    /** Restore pipeline state from project metadata */
    _restorePipelineState(meta) {
        const phase = meta.current_phase || 'idle';
        const phaseOrder = { idle:0, platform_scan:1, topic_selection:2, mini_arc_outline:3, bible_construction:4, character_creation:5, master_outline:6 };
        const stepMap = { 0:'scan', 1:'topic', 2:'arc', 3:'bible', 4:'chars', 5:'outline' };
        const idx = phaseOrder[phase] || 0;
        Object.keys(stepMap).forEach(k => {
            const s = stepMap[k];
            if (parseInt(k) < idx) this._updatePipelineBadge(s, 'done');
            else if (parseInt(k) === idx) this._updatePipelineBadge(s, 'active');
        });
        // If chapters have been written, activate write step
        if (meta.current_chapter > 0) this._updatePipelineBadge('write', 'active');
        // Show the start button if we're at scan step
        if (idx <= 1) {
            const btnStart = document.getElementById('btn-start-scan');
            if (btnStart) btnStart.style.display = '';
        }
        // Hide scan input unless we have scan data
        const scanInput = document.getElementById('scan-input-area');
        if (scanInput) scanInput.style.display = 'none';
    },

    /** Skip scan and go directly to bible construction */
    async skipScan() {
        if (!this.currentProjectId) return;
        this._updatePipelineBadge('scan', 'done');
        this._updatePipelineBadge('topic', 'done');
        this._updatePipelineBadge('arc', 'done');
        this._updatePipelineBadge('bible', 'active');
        document.getElementById('btn-start-scan').style.display = 'none';
        document.getElementById('scan-input-area').style.display = 'none';
        try { await API.startWorkflow(this.currentProjectId); }
        catch (err) { alert(`启动失败: ${err.message}`); }
    },

    async confirmDecision(decision) {
        if (!this.currentProjectId) return;
        const fb = document.getElementById('feedback-input')?.value || '';
        try { await API.submitDecision(this.currentProjectId, decision, fb || null, null); document.querySelector('.confirm-panel')?.remove(); }
        catch (err) { alert(`提交失败: ${err.message}`); }
    },

    toggleChapterEdit(num) {
        const display = document.getElementById(`chapter-display-${num}`);
        const editor = document.getElementById(`chapter-editor-${num}`);
        if (!display || !editor) return;
        const editing = editor.style.display !== 'none';
        if (editing) {
            editor.style.display = 'none'; display.style.display = '';
        } else {
            document.getElementById(`chapter-textarea-${num}`).value = display.innerText;
            editor.style.display = ''; display.style.display = 'none';
        }
    },

    async saveChapterEdit(num) {
        const textarea = document.getElementById(`chapter-textarea-${num}`);
        if (!textarea) return;
        const newContent = textarea.value;
        try {
            await API.updateBibleSection(this.currentProjectId, `chapter-${num}`, newContent);
            document.getElementById(`chapter-display-${num}`).innerHTML = Components._esc(newContent);
            document.getElementById(`chapter-editor-${num}`).style.display = 'none';
            document.getElementById(`chapter-display-${num}`).style.display = '';
            document.getElementById('phase-label').textContent = '已保存 ✓';
            setTimeout(() => { const pl = document.getElementById('phase-label'); if (pl && pl.textContent === '已保存 ✓') pl.textContent = '就绪'; }, 2000);
        } catch (err) { alert(`保存失败: ${err.message}`); }
    },

    async deleteChapter(num) {
        if (!this.currentProjectId || !confirm(`确认删除第${num}章？此操作不可恢复。`)) return;
        try {
            await API.deleteChapter(this.currentProjectId, num);
            this._loadTabContent('chapters');
        } catch (err) { alert(`删除失败: ${err.message}`); }
    },

    async deleteCurrentProject() {
        if (this.currentProjectId) this.deleteBook(this.currentProjectId);
    },

    // ================================================================
    // WebSocket
    // ================================================================
    _connectWS(projectId) {
        if (this.ws) this.ws.close();
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${proto}//${location.host}/ws/${projectId}`);
        this.ws.onopen = () => this._updateApiStatus(true);
        this.ws.onmessage = (e) => { if (projectId === this.currentProjectId) this._handleWSMessage(JSON.parse(e.data)); };
        this.ws.onclose = () => this._updateApiStatus(false);
        this.ws.onerror = () => this._updateApiStatus(false);
    },

    _handleWSMessage(msg) {
        const { type, phase, progress, message, chapter, scores, token, data: msgData } = msg;
        const pb = document.getElementById('progress-fill');
        const pl = document.getElementById('phase-label');
        const pm = { platform_scan:'平台扫榜', topic_selection:'选题研究', mini_arc_outline:'小事件大纲', bible_construction:'构建世界观', character_creation:'创建角色', master_outline:'生成大纲', chapter_planning:'规划章节', chapter_writing:'写作中', quality_review:'审阅中', polish_revision:'润色中', memory_update:'更新记忆' };
        const tm = { platform_scan:'topics', topic_selection:'topics', mini_arc_outline:'topics', bible_construction:'bible', character_creation:'characters', master_outline:'outline', chapter_planning:'chapters', chapter_writing:'chapters' };
        // Pipeline badge mapping
        const phaseToStep = { platform_scan:'scan', topic_selection:'topic', mini_arc_outline:'arc', bible_construction:'bible', character_creation:'chars', master_outline:'outline' };

        switch (type) {
            case 'phase_update':
                if (pl) pl.textContent = `${pm[phase]||phase} · ${message||''}`;
                if (pb) pb.style.width = `${(progress||0)*100}%`;
                if (tm[phase]) this._switchTab(tm[phase]);
                // Update pipeline badge to running
                if (phaseToStep[phase]) this._updatePipelineBadge(phaseToStep[phase], 'running');
                // Hide scan start button when scan starts
                if (phase === 'platform_scan') {
                    const btnStart = document.getElementById('btn-start-scan');
                    if (btnStart) btnStart.style.display = 'none';
                }
                break;
            case 'phase_complete':
                if (pl) pl.textContent = `${pm[phase]||phase} 完成 ✓`;
                if (pb) pb.style.width = '100%';
                if (phaseToStep[phase]) {
                    const step = phaseToStep[phase];
                    this._updatePipelineBadge(step, 'done');
                    if (msgData) this._renderPhaseResult(step, msgData);
                    // Show confirm UI per step
                    if (step === 'scan') {
                        // Auto-confirm scan → proceed to topic selection
                        this._updatePipelineBadge('topic', 'active');
                        API.confirmPhase(this.currentProjectId, null).catch(() => {});
                        // Clear scan status text
                        const statusEl = document.getElementById('scan-status');
                        if (statusEl) statusEl.innerHTML = '';
                    } else if (step === 'topic') {
                        document.getElementById('topic-confirm-area').style.display = 'flex';
                    } else if (step === 'arc') {
                        document.getElementById('arc-confirm-area').style.display = 'flex';
                    } else if (step === 'bible') {
                        document.getElementById('bible-confirm-area').style.display = 'flex';
                    } else if (step === 'chars') {
                        document.getElementById('chars-confirm-area').style.display = 'flex';
                    } else if (step === 'outline') {
                        document.getElementById('outline-confirm-area').style.display = 'flex';
                    }
                }
                if (tm[phase]) { this._switchTab(tm[phase]); this._loadTabContent(tm[phase]); }
                break;
            case 'phase_blocked': this._showPhaseConfirmation(phase); break;
            case 'token': if (token) this._appendStreamToken(token); else this._onStreamEnd(); break;
            case 'stream_end': this._onStreamEnd(); break;
            case 'chapter_complete':
                this._updatePipelineBadge('write', 'active');
                if (chapter && scores) {
                    const ov = document.getElementById('overview-content');
                    if (ov && !ov.querySelector('.confirm-panel')) ov.insertAdjacentHTML('beforeend', Components.confirmPanel(chapter, { overall_score:scores.overall_score||7, dimension_scores:scores, issues:[] }));
                }
                break;
            case 'workflow_complete':
                this._workflowDone = true;
                this._updatePipelineBadge('write', 'done');
                if (pl) pl.textContent = '全部完成 ✓';
                if (pb) pb.style.width = '100%';
                if (this.currentProjectId) this._loadTabContent('chapters');
                this._refreshProjects();
                break;
            case 'error':
                Object.keys(this._pipelineState).filter(s => this._pipelineState[s] === 'running').forEach(s => this._updatePipelineBadge(s, 'failed'));
                document.getElementById('runtime-message').textContent = msg.error || '工作流执行失败';
                this._pollRuntime();
                break;
            case 'topic_editing':
                document.getElementById('topic-entry').style.display = '';
                document.getElementById('btn-research-topic').disabled = false;
                break;
            case 'workflow_paused':
            case 'workflow_resumed':
                this._pollRuntime();
                break;
        }
    },

    _renderPhaseResult(step, data) {
        if (!data) return;
        this._phaseResults ||= {};
        this._phaseResults[step] = data;
        try {
            if (step === 'scan') this._renderScanResult(data);
            else if (step === 'topic') this._renderTopicResult(data);
            else if (step === 'arc') this._renderArcResult(data);
            else if (step === 'bible') this._renderBibleResult(data);
            else if (step === 'chars') this._renderCharsResult(data);
            else if (step === 'outline') this._renderOutlineResult(data);
            else if (step === 'write') this._renderWriteResult(data);
        } catch(e) { console.error('Render phase result error:', e); }
        this._rememberWorkspace();
    },

    _renderScanResult(data) {
        const el = document.getElementById('scan-result-area');
        if (!el) return;
        let totalEntries = 0, html = '';
        const genreCount = {};
        const allEntries = [];

        const collectEntries = (platformData, platformName) => {
            if (!platformData?.entries) return;
            (platformData.entries || []).forEach(e => {
                if (e.genre) {
                    const g = e.genre.replace(/[\/／].*/, '').trim();
                    genreCount[g] = (genreCount[g] || 0) + 1;
                }
                totalEntries++;
                allEntries.push({...e, _platform: platformName});
            });
        };
        collectEntries(data.feilu, '飞卢');
        collectEntries(data.fanqie, '番茄');

        // Dashboard tiles
        html += '<div class="dash-grid">';
        html += `<div class="dash-tile accent"><div class="dash-num">${totalEntries}</div><div class="dash-label">扫描书籍</div></div>`;
        const platforms = [data.feilu, data.fanqie].filter(Boolean);
        html += `<div class="dash-tile success"><div class="dash-num">${platforms.length}</div><div class="dash-label">覆盖平台</div></div>`;
        html += `<div class="dash-tile warning"><div class="dash-num">${Object.keys(genreCount).length}</div><div class="dash-label">识别题材</div></div>`;
        html += '</div>';

        // Bar chart of top genres
        const sortedGenres = Object.entries(genreCount).sort((a,b) => b[1]-a[1]).slice(0, 8);
        if (sortedGenres.length) {
            const maxCount = sortedGenres[0][1];
            html += '<p style="font-weight:600;font-size:0.82rem;margin-bottom:6px">📊 热门题材分布</p>';
            html += '<div class="bar-chart">';
            sortedGenres.forEach(([g, c], i) => {
                const pct = Math.round((c/maxCount)*100);
                const colors = ['','warm','cool','green'];
                html += `<div class="bar-row"><span class="bar-label">${Components._esc(g)}</span><div class="bar-track"><div class="bar-fill ${colors[i%4]||''}" style="width:${pct}%"></div></div><span class="bar-val">${c}</span></div>`;
            });
            html += '</div>';
        }

        // Book list by platform
        platforms.forEach(p => {
            const isFeilu = p.platform === '飞卢' || data.feilu === p;
            const entries = p.entries || [];
            html += `<div class="scan-mini-card" style="margin-bottom:10px"><h4>${isFeilu?'🔍 飞卢':'🍅 番茄'} · ${Components._esc(p.list_name||'榜单')} · ${Components._esc(p.date||'')}</h4>`;
            if (p.scan_failed) {
                html += `<p style="color:var(--error)">${Components._esc(p.summary||'扫榜失败')}</p>`;
            } else {
                html += `<p style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:8px">${Components._esc((p.summary||'').substring(0,120))}</p>`;
                if (entries.length) {
                    html += '<div class="scan-book-list">';
                    entries.forEach((e, i) => {
                        const title = e.title || '';
                        html += `<div class="scan-book-row"><span class="scan-book-rank">#${i+1}</span><span class="scan-book-title">${Components._esc(title)}</span>${e.genre?`<span class="tag-chip gray">${Components._esc(e.genre)}</span>`:''}</div>`;
                    });
                    html += '</div>';
                }
            }
            html += '</div>';
        });

        el.innerHTML = html; el.style.display = 'block';
        document.getElementById('scan-input-area').style.display = 'none';
        document.getElementById('btn-start-scan').style.display = 'none';
        // Clear status
        const statusEl = document.getElementById('scan-status');
        if (statusEl) statusEl.innerHTML = '';
    },

    _renderTopicResult(data) {
        this._topicScores = data.scores?.scores || [];
        this._topicTitleData = data.title_synopsis || [];
        this._topicCandidates = data.candidates?.topics || [];
        this._topicCrossPlatform = data.cross_platform;
        this._checkedCandidates = {};
        this._synopsisCards = [];
        this._selectedSynopsisIdx = -1;

        const allTopics = [];
        const seen = new Set();

        // Priority 1: Scored topics
        for (const t of this._topicScores) {
            const name = t.genre_name;
            if (name && !seen.has(name)) { seen.add(name); allTopics.push({name, score: t.total_score, data: t}); }
        }
        // Priority 2: Candidates without scores
        for (const t of this._topicCandidates) {
            const name = t.genre_name;
            if (name && !seen.has(name)) { seen.add(name); allTopics.push({name, score: 0, data: t}); }
        }

        const candidatesArea = document.getElementById('topic-candidates-area');
        const candidatesList = document.getElementById('topic-candidates-list');
        const aiArea = document.getElementById('topic-ai-area');

        if (!allTopics.length) {
            // No topics at all — show retry UI with helpful context
            if (candidatesArea) candidatesArea.style.display = 'none';
            if (aiArea) {
                aiArea.style.display = 'block';
                const scanOk = (data.feilu?.entries?.length || 0) + (data.fanqie?.entries?.length || 0) > 0;
                const msg = scanOk
                    ? '⚠️ 扫榜已完成但未成功生成候选题材，可能是AI生成步骤出现问题。请点击重试，或在下方输入灵感手动生成。'
                    : '⚠️ 未生成候选题材，可能扫榜数据不足。请点击重试按钮，或在下方输入你的灵感。';
                aiArea.querySelector('p').innerHTML = msg +
                    '&nbsp;<button class="btn btn-warning btn-sm" onclick="App.retryPhase(\'topic_selection\')" style="margin-left:8px">🔄 重新生成选题</button>';
                aiArea.querySelector('p').style.color = 'var(--warning)';
            }
            return;
        }

        // Show candidates
        if (candidatesArea && candidatesList) {
            candidatesArea.style.display = 'block';
            let listHtml = '';
            allTopics.slice(0, 12).forEach((t, i) => {
                const name = Components._esc(t.name);
                const score = t.score ? (t.score).toFixed(1) : '—';
                listHtml += `<button type="button" class="topic-candidate-row" data-genre="${name}" aria-pressed="false">
                    <div class="topic-candidate-check">✓</div>
                    <span class="topic-candidate-name">${name}</span>
                    <span class="topic-candidate-score">${score}${t.score?'分':''}</span>
                </button>`;
            });
            candidatesList.innerHTML = listHtml;
            candidatesList.querySelectorAll('.topic-candidate-row').forEach(row => {
                row.onclick = () => this.toggleCandidate(row.dataset.genre);
            });
            this._allTopics = allTopics.slice(0, 12);
        }

        if (aiArea) aiArea.style.display = 'block';
    },

    /** Toggle candidate checkbox */
    toggleCandidate(genreName) {
        this._checkedCandidates[genreName] = !this._checkedCandidates[genreName];
        const row = Array.from(document.querySelectorAll('.topic-candidate-row')).find(el => el.dataset.genre === genreName);
        if (row) { row.classList.toggle('checked', this._checkedCandidates[genreName]); row.setAttribute('aria-pressed', String(this._checkedCandidates[genreName])); }
        const count = Object.values(this._checkedCandidates).filter(Boolean).length;
        const hint = document.getElementById('candidate-hint');
        if (hint) hint.textContent = `已选 ${count} 个`;
        this._rememberWorkspace();
    },

    /** Generate synopsis cards for checked candidates, calling LLM on demand */
    async generateSynopses() {
        const checked = Object.entries(this._checkedCandidates).filter(([_,v]) => v).map(([k]) => k);
        if (!checked.length) { alert('请至少勾选一个题材'); return; }

        const cardsContainer = document.getElementById('topic-synopsis-cards');
        if (!cardsContainer) return;
        cardsContainer.style.display = 'block';
        cardsContainer.innerHTML = '<p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px">📝 正在生成书名和简介...</p>';

        this._synopsisCards = [];
        this._selectedSynopsisIdx = -1;

        const titleData = this._topicTitleData || [];
        const inspEl = document.getElementById('topic-ai-input');
        const inspiration = inspEl?.value?.trim() || '';

        for (let idx = 0; idx < checked.length; idx++) {
            const genreName = checked[idx];
            const ts = titleData.find(t => t.genre_name === genreName);
            let title = ts?.final_title || '';
            let synopsis = ts?.final_synopsis || '';

            // If no pre-generated synopsis, call API to generate on demand
            if (!title || !synopsis) {
                try {
                    cardsContainer.innerHTML = `<p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px">📝 正在为「${Components._esc(genreName)}」生成书名和简介...</p>`;
                    const result = await API.generateSynopsis(this.currentProjectId, genreName, inspiration);
                    title = result.final_title || genreName;
                    synopsis = result.final_synopsis || '';
                } catch (err) {
                    console.error('Synopsis generation failed for', genreName, err);
                    cardsContainer.textContent = `生成失败：${err.message}。请检查右侧运行记录后重试。`;
                    cardsContainer.classList.add('inline-error');
                    return;
                }
            }

            const card = { genreName, title, synopsis, editedTitle: title, editedSynopsis: synopsis };
            this._synopsisCards.push(card);
            const cardIdx = this._synopsisCards.length - 1;
            const cardHtml = this._renderSynopsisCard(card, cardIdx);
            if (idx === 0) {
                cardsContainer.innerHTML = '<p style="font-weight:600;font-size:0.82rem;margin-bottom:6px">📝 书名和简介（点击圆圈选择，标题和简介可编辑）</p>';
            }
            cardsContainer.insertAdjacentHTML('beforeend', cardHtml);
        }

        // Show confirm bar after all cards generated
        if (this._synopsisCards.length === 1) this.selectSynopsisCard(0);
        document.getElementById('topic-confirm-area').style.display = 'flex';
    },

    /** Render a single synopsis card */
    _renderSynopsisCard(card, idx) {
        const name = Components._esc(card.genreName);
        return `<div class="synopsis-card" id="synopsis-card-${idx}">
            <div class="synopsis-card-header">
                <button type="button" class="synopsis-radio" onclick="App.selectSynopsisCard(${idx})" aria-label="选择书名：${Components._esc(card.editedTitle)}" aria-pressed="false"></button>
                <input aria-label="书名" class="synopsis-title-input" id="synopsis-title-${idx}" value="${Components._esc(card.editedTitle)}" onchange="App._synopsisCards[${idx}].editedTitle=this.value">
            </div>
            <div class="synopsis-body">
                <textarea aria-label="简介" class="synopsis-desc-input" id="synopsis-desc-${idx}" onchange="App._synopsisCards[${idx}].editedSynopsis=this.value">${Components._esc(card.editedSynopsis)}</textarea>
            </div>
            <div class="synopsis-meta">
                <span>题材：${name}</span>
            </div>
        </div>`;
    },

    /** Radio-select a synopsis card */
    selectSynopsisCard(idx) {
        this._selectedSynopsisIdx = idx;
        document.querySelectorAll('.synopsis-card').forEach((el, i) => {
            el.classList.toggle('selected', i === idx);
            el.querySelector('.synopsis-radio')?.setAttribute('aria-pressed', String(i === idx));
        });
        this._rememberWorkspace();
    },

    /** AI generate titles based on user inspiration */
    async aiGenerateTitles() {
        const input = document.getElementById('topic-ai-input');
        const resultsEl = document.getElementById('topic-ai-results');
        const btn = document.getElementById('btn-ai-generate');
        const insp = input?.value?.trim();
        if (!insp) { alert('请先输入灵感或想法'); return; }

        btn.textContent = '生成中...'; btn.disabled = true;
        resultsEl.innerHTML = '<span style="color:var(--text-secondary);font-size:0.82rem">AI 正在分析榜单数据并生成书名...</span>';

        try {
            const r = await fetch('/api/projects/' + this.currentProjectId + '/ai-titles', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({inspiration: insp})
            });
            if (!r.ok) throw new Error((await r.json()).detail || '请求失败');
            const data = await r.json();
            if (data.titles?.length) {
                resultsEl.innerHTML = '<p style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:4px">AI 生成的书名（点击添加到候选列表）：</p>';
                data.titles.forEach(t => {
                    const chip = document.createElement('span');
                    chip.className = 'tag-chip purple';
                    chip.style.cssText = 'cursor:pointer;margin:3px;font-size:0.82rem;padding:4px 12px';
                    chip.textContent = t;
                    chip.onclick = () => {
                        input.value = t;
                        // Add to checked candidates
                        const name = t;
                        if (!this._checkedCandidates[name]) {
                            this._checkedCandidates[name] = true;
                            const row = document.querySelector(`.topic-candidate-row[data-genre="${Components._esc(name)}"]`);
                            if (row) row.classList.add('checked');
                            else {
                                // Add a new row
                                this._allTopics.push({name, score: 0, data: {}});
                                const list = document.getElementById('topic-candidates-list');
                                const newRow = document.createElement('div');
                                newRow.className = 'topic-candidate-row checked';
                                newRow.dataset.genre = name;
                                newRow.innerHTML = `<div class="topic-candidate-check">✓</div><span class="topic-candidate-name">${Components._esc(name)}</span><span class="topic-candidate-score">AI</span>`;
                                newRow.onclick = () => App.toggleCandidate(name);
                                list.appendChild(newRow);
                            }
                            const count = Object.values(this._checkedCandidates).filter(Boolean).length;
                            const hint = document.getElementById('candidate-hint');
                            if (hint) hint.textContent = `已选 ${count} 个`;
                        }
                    };
                    resultsEl.appendChild(chip);
                });
            } else {
                resultsEl.innerHTML = '<span style="color:var(--text-secondary);font-size:0.82rem">未生成结果，请尝试更具体的灵感描述</span>';
            }
        } catch (err) {
            resultsEl.innerHTML = `<span style="color:var(--error);font-size:0.82rem">生成失败: ${err.message}</span>`;
        } finally {
            btn.textContent = '生成'; btn.disabled = false;
        }
    },

    _renderArcResult(data) {
        const el = document.getElementById('arc-result-area');
        if (!el) return;
        const outlines = data.mini_arc_outline || data;
        const keys = Object.keys(outlines).filter(k => k !== 'mini_arc_outline');
        // Filter entries that actually have chapter data (not just empty array)
        const entries = keys.map(k => [k, outlines[k]]).filter(([_,v]) => v?.chapters?.length > 0);
        let html = '';

        if (!entries.length) {
            el.innerHTML = `<div style="padding:16px;border:1px dashed var(--warning);border-radius:8px;text-align:center">
                <p style="color:var(--warning);margin-bottom:12px">⚠️ 大纲生成未完成（可能是模型结构化输出失败）</p>
                <p style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:12px">请在下方输入框中补充更多细节，然后点击重新生成</p>
                <button class="btn btn-warning" onclick="App.retryPhase('mini_arc_outline')" style="margin-right:8px">🔄 重新生成大纲</button>
            </div>`;
            el.style.display = 'block';
            // Show the confirm/inspiration area so user can add details
            const confirmEl = document.getElementById('arc-confirm-area');
            if (confirmEl) confirmEl.style.display = 'flex';
            return;
        }

        // Stats
        const totalChapters = entries.reduce((sum, [_,v]) => sum + (v.chapters?.length||0), 0);
        html += '<div class="dash-grid">';
        html += `<div class="dash-tile accent"><div class="dash-num">${entries.length}</div><div class="dash-label">生成方案</div></div>`;
        html += `<div class="dash-tile success"><div class="dash-num">${totalChapters}</div><div class="dash-label">总章节数</div></div>`;
        html += `<div class="dash-tile warning"><div class="dash-num">${this._esc(entries[0]?.[1]?.total_words || '—')}</div><div class="dash-label">单方案目标字数</div></div>`;
        html += '</div>';

        entries.forEach(([genre, arc]) => {
            html += `<div style="margin-bottom:12px"><p style="font-weight:600;margin-bottom:6px">📋 ${Components._esc(genre)} · ${Components._esc(arc.total_words||'约2万字')}</p>`;
            html += '<div class="timeline">';
            (arc.chapters||[]).forEach((c, i) => {
                html += `<div class="tl-node${i<3?' done':''}"><div class="tl-card"><div class="tl-title">第${c.chapter_number||(i+1)}章</div><div class="tl-sub">${Components._esc((c.goal||c.conflict||'').substring(0,50))}</div></div></div>`;
            });
            html += '</div></div>';
        });

        el.innerHTML = html; el.style.display = 'block';
    },

    _renderBibleResult(data) {
        const el = document.getElementById('bible-result-area');
        if (!el) return;
        const w = data.world || {};
        const factions = data.factions || [];
        const themes = data.themes || [];
        const style = data.style_contract || {};
        let html = '';

        // Dashboard tiles
        html += '<div class="dash-grid">';
        html += `<div class="dash-tile accent"><div class="dash-num">${w.name ? 1 : 0}</div><div class="dash-label">世界观</div></div>`;
        html += `<div class="dash-tile success"><div class="dash-num">${factions.length}</div><div class="dash-label">势力组织</div></div>`;
        html += `<div class="dash-tile warning"><div class="dash-num">${themes.length}</div><div class="dash-label">核心主题</div></div>`;
        html += `<div class="dash-tile accent"><div class="dash-num">${w.magic_system?'✓':'—'}</div><div class="dash-label">力量体系</div></div>`;
        html += '</div>';

        // World summary
        if (w.name) {
            html += `<div style="margin-bottom:8px"><strong>${Components._esc(w.name)}</strong> <span class="tag-chip blue">${Components._esc(w.world_type||'')}</span></div>`;
            if (w.geography) html += `<p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:4px">🌏 ${Components._esc(w.geography.substring(0,100))}</p>`;
            if (w.culture) html += `<p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:4px">🏛 ${Components._esc(w.culture.substring(0,100))}</p>`;
            if (w.technology_level) html += `<p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:4px">⚙ ${Components._esc(w.technology_level)}</p>`;
        }

        // Faction chips
        if (factions.length) {
            html += '<p style="font-weight:600;font-size:0.8rem;margin-top:8px">势力：</p>';
            factions.forEach(f => {
                html += `<span class="tag-chip purple">${Components._esc(f.name)}</span>`;
            });
            html += '<br>';
        }

        // Style contract summary
        if (style.tone) {
            html += '<p style="font-size:0.78rem;color:var(--text-secondary);margin-top:8px">文风：';
            html += `<span class="tag-chip gray">${Components._L(Components.TONE, style.tone)}</span>`;
            if (style.pacing_preference) html += `<span class="tag-chip gray">${Components._L(Components.PACING, style.pacing_preference)}</span>`;
            if (style.sentence_style) html += `<span class="tag-chip gray">${Components._L(Components.SENTENCE, style.sentence_style)}</span>`;
            html += '</p>';
        }

        el.innerHTML = html; el.style.display = 'block';
    },

    _renderCharsResult(data) {
        const el = document.getElementById('chars-result-area');
        if (!el) return;
        const chars = data.characters || {};
        const list = Object.values(chars);
        let html = '';

        // Stats
        html += '<div class="dash-grid">';
        html += `<div class="dash-tile accent"><div class="dash-num">${list.length}</div><div class="dash-label">角色总数</div></div>`;
        const roles = { protagonist:0, antagonist:0, deuteragonist:0, supporting:0, mentor:0 };
        list.forEach(c => { if (roles[c.role] !== undefined) roles[c.role]++; });
        html += `<div class="dash-tile success"><div class="dash-num">${roles.protagonist||0}</div><div class="dash-label">主角</div></div>`;
        html += `<div class="dash-tile warning"><div class="dash-num">${roles.antagonist||0}</div><div class="dash-label">反派</div></div>`;
        html += '</div>';

        // Character cards
        list.forEach(c => {
            const roleLabel = Components._L(Components.ROLE, c.role) || '';
            const archetypeLabel = Components._L(Components.ARCHETYPE, c.archetype) || '';
            html += `<div class="char-card">
                <span class="char-name">${Components._esc(c.name)}</span>
                ${roleLabel?`<span class="tag-chip purple">${roleLabel}</span>`:''}
                ${archetypeLabel?`<span class="tag-chip blue">${archetypeLabel}</span>`:''}
                <p style="font-size:0.8rem;margin-top:4px;color:var(--text-secondary)">${Components._esc((c.personality||'').substring(0,80))}</p>
                ${c.motivation?`<p style="font-size:0.78rem;color:var(--text-secondary)">动机：${Components._esc(c.motivation.substring(0,60))}</p>`:''}
            </div>`;
        });

        el.innerHTML = html; el.style.display = 'block';
    },

    _renderOutlineResult(data) {
        const el = document.getElementById('outline-result-area');
        if (!el) return;
        let html = '';
        const volumes = data.volumes || [];
        const mainPlot = data.main_plot || [];
        const subplots = data.subplots || [];
        const tps = data.major_turning_points || [];

        // Stats
        html += '<div class="dash-grid">';
        html += `<div class="dash-tile accent"><div class="dash-num">${volumes.length}</div><div class="dash-label">分卷</div></div>`;
        html += `<div class="dash-tile success"><div class="dash-num">${data.chapter_count||'?'}</div><div class="dash-label">计划章节</div></div>`;
        html += `<div class="dash-tile warning"><div class="dash-num">${mainPlot.length+subplots.length}</div><div class="dash-label">故事线</div></div>`;
        html += '</div>';

        // Logline
        if (data.logline) {
            html += `<p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:10px;font-style:italic">"${Components._esc(data.logline.substring(0,120))}"</p>`;
        }

        // Volume tree
        if (volumes.length) {
            html += '<div class="volume-tree">';
            volumes.forEach(v => {
                html += `<div class="volume-node">
                    <div class="volume-header"><span class="vol-num">${v.number||'?'}</span>${Components._esc(v.title||'未命名')}</div>
                    <div class="volume-body">第${v.start_chapter||'?'}-${v.end_chapter||'?'}章 · ${Components._esc(v.logline||'')}</div>
                </div>`;
            });
            html += '</div>';
        }

        // Turning points timeline
        if (tps.length) {
            html += '<p style="font-weight:600;font-size:0.8rem;margin-top:10px">⏳ 关键转折点</p>';
            html += '<div class="timeline">';
            tps.forEach(tp => {
                html += `<div class="tl-node done"><div class="tl-card"><div class="tl-title">第${tp.chapter||'?'}章：${Components._L(Components.TURNING, tp.turning_type)}</div><div class="tl-sub">${Components._esc((tp.description||'').substring(0,80))}</div></div></div>`;
            });
            html += '</div>';
        }

        el.innerHTML = html; el.style.display = 'block';
    },

    _renderWriteResult(data) {
        const el = document.getElementById('write-result-area');
        if (!el) return;
        let html = '';
        // Fetch chapters via API for up-to-date data
        if (this.currentProjectId) {
            API.getChapters(this.currentProjectId).then(chapters => {
                const list = Array.isArray(chapters) ? chapters : [];
                const done = list.filter(c => c.status === 'done').length;
                html += '<div class="dash-grid">';
                html += `<div class="dash-tile accent"><div class="dash-num">${done}</div><div class="dash-label">已完成</div></div>`;
                html += `<div class="dash-tile success"><div class="dash-num">${list.length}</div><div class="dash-label">总章节</div></div>`;
                html += '</div>';
                if (list.length) {
                    html += '<div class="chapter-progress-grid">';
                    list.forEach(c => {
                        const isDone = c.status === 'done';
                        html += `<div class="chapter-progress-chip ${isDone?'done':'active'}" title="第${c.chapter_number}章">${c.chapter_number}</div>`;
                    });
                    html += '</div>';
                }
                el.innerHTML = html; el.style.display = 'block';
            }).catch(() => {
                el.innerHTML = '<p style="font-size:0.85rem;color:var(--text-secondary)">章节生成进行中...</p>';
                el.style.display = 'block';
            });
        }
    },

    _appendStreamToken(token) {
        let el = document.getElementById('stream-output');
        if (!el) {
            const at = document.querySelector('#view-project .tab-content.active');
            if (!at) return;
            const c = document.createElement('div'); c.className = 'stream-container';
            c.innerHTML = '<div class="stream-header">正在生成...</div><pre id="stream-output" class="stream-text streaming"></pre>';
            at.insertBefore(c, at.firstChild); el = document.getElementById('stream-output');
        }
        if (el) { el.textContent += token; el.scrollTop = el.scrollHeight; }
    },

    _onStreamEnd() {
        document.getElementById('stream-output')?.classList.remove('streaming');
        setTimeout(() => { const at = document.querySelector('#view-project .tab.active'); if (at) this._loadTabContent(at.dataset.tab); }, 500);
    },

    _showPhaseConfirmation(phase) {
        document.querySelector('.phase-confirm')?.remove();
        const ac = document.querySelector('#view-project .tab-content.active');
        if (!ac) return;
        ac.insertAdjacentHTML('beforeend', Components.phaseConfirmPanel(phase));
    },

    _switchTab(n) { document.querySelector(`#view-project .tab[data-tab="${n}"]`)?.click(); },

    // ================================================================
    // New Project Form
    // ================================================================
    // Form handlers removed — project creation is now automatic on "开始扫榜"
    _setupFormHandlers() {
        // No setup needed — the old modal form has been removed.
        // Projects are auto-created when clicking "开始扫榜" and finalized on topic confirmation.
    },

    _updateApiStatus(c) {
        const el = document.getElementById('api-status'); if (!el) return;
        if (c===undefined) { fetch('/api/projects').then(()=>{el.className='status-dot online';}).catch(()=>{el.className='status-dot offline';}); }
        else { el.className = c ? 'status-dot online' : 'status-dot offline'; }
    },
    _esc(s) { return Components._esc(s); },

    // ================================================================
    // Scan Step — auto-creates draft project, auto-scrapes platforms
    // ================================================================
    async startScan() {
        // 1. Auto-create draft project if needed
        if (!this.currentProjectId) {
            const draftConfig = {
                title: '未命名项目',
                inspiration: '待定',
                genre: ['待定'],
                target_readers: '网文读者',
                tone: '',
                target_length: 'novel',
                target_word_count: 80000,
                style_reference: null,
                taboo_content: [],
                language: 'zh-CN',
                special_requirements: [],
            };
            try {
                const result = await API.createProject(draftConfig);
                await this._refreshProjects();
                this.currentProjectId = result.project_id;
                this._connectWS(result.project_id);
                this._initPipeline();
                this._showProjectHeader('未命名项目');
            } catch (err) { alert(`创建失败: ${err.message}`); return; }
        }

        // 2. Hide start button, show scanning status
        document.getElementById('btn-start-scan').style.display = 'none';
        const scanBody = document.getElementById('body-scan');
        let statusEl = document.getElementById('scan-status');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.id = 'scan-status';
            statusEl.style.cssText = 'padding:12px 0;font-size:0.9rem;color:var(--text-secondary);';
            scanBody.appendChild(statusEl);
        }
        statusEl.innerHTML = '🔍 正在自动抓取飞卢和番茄榜单数据... <span style="color:var(--accent)">请稍候</span>';

        // 3. Try auto-scan
        try {
            const result = await API.autoScan(this.currentProjectId);

            if (result.status === 'ok' || result.status === 'partial') {
                // Scan succeeded (at least partially) — start workflow
                statusEl.innerHTML = `📊 ${result.message}（飞卢:${result.feilu.chars}字符, 番茄:${result.fanqie.chars}字符）`;
                await API.startWorkflow(this.currentProjectId);
                this._updatePipelineBadge('scan', 'running');
                statusEl.innerHTML += '<br><span style="color:var(--success)">✅ 扫榜任务已提交，正在分析中...</span>';
                return;
            } else {
                // Both platforms failed
                statusEl.innerHTML = `⚠️ ${result.message}<br><small style="color:var(--text-secondary)">飞卢和番茄榜单均抓取失败，请手动粘贴页面内容</small>`;
            }
        } catch (err) {
            console.error('Auto-scan failed:', err);
            statusEl.innerHTML = '⚠️ 自动扫榜失败，请手动粘贴榜单内容';
        }

        // 4. Fallback: show manual paste area
        document.getElementById('scan-input-area').style.display = 'block';
    },

    /** Show project header in workspace */
    _showProjectHeader(title) {
        document.getElementById('workspace-default-title').style.display = 'none';
        document.getElementById('workspace-project-header').style.display = 'flex';
        document.getElementById('project-title-display').textContent = '《' + title + '》';
    },

    /** Navigate to 我的书库 */
    goToLibrary() {
        this._navigate('my-works');
    },

    // ================================================================
    // Topic Selection
    // ================================================================
    _scanProjectId: null,  // Original project that holds scan data
    _selectedTopic: null,

    selectTopic(genreName) {
        this._selectedTopic = genreName;
        document.querySelectorAll('.topic-select-item').forEach(el => {
            el.classList.toggle('selected', el.dataset.genre === genreName);
        });
        // Auto-fill the editable title
        const titleData = this._topicTitleData?.find(t => t.genre_name === genreName);
        const titleInput = document.getElementById('topic-edit-title');
        if (titleInput) {
            titleInput.value = titleData?.final_title || genreName;
        }
    },

    async confirmTopic() {
        // Get selected synopsis card or fall back to checked topic
        let newTitle, genreName;
        const insp = document.getElementById('topic-inspiration')?.value || '';

        if (this._selectedSynopsisIdx >= 0 && this._synopsisCards[this._selectedSynopsisIdx]) {
            const card = this._synopsisCards[this._selectedSynopsisIdx];
            newTitle = card.editedTitle || card.title;
            genreName = card.genreName;
        } else {
            // No synopsis card selected — use first checked candidate
            const checked = Object.entries(this._checkedCandidates || {}).filter(([_,v]) => v).map(([k]) => k);
            if (!checked.length) { alert('请先勾选题材并生成简介，然后选择一个书名'); return; }
            genreName = checked[0];
            newTitle = genreName;
        }

        try {
            await API.updateTitle(this.currentProjectId, newTitle);
            await this._refreshProjects();
            this._showProjectHeader(newTitle);

            document.getElementById('topic-confirm-area').style.display = 'none';
            this._updatePipelineBadge('topic', 'done');
            this._updatePipelineBadge('arc', 'active');

            const confirmMsg = `选定题材：${genreName}。书名：《${newTitle}》。${insp}`;
            const selected = this._synopsisCards?.[this._selectedSynopsisIdx];
            await API.confirmPhase(this.currentProjectId, confirmMsg, {
                genre_name:genreName, final_title:newTitle,
                final_synopsis:selected?.editedSynopsis || selected?.synopsis || insp,
            });
        } catch (err) { alert(`确认失败: ${err.message}`); }
    },

    // ================================================================
    // Generic Step Confirmation (arc, bible, chars, outline)
    // ================================================================
    async confirmStep(step) {
        if (!this.currentProjectId) return;
        const inspEl = document.getElementById(`${step}-inspiration`);
        const insp = inspEl?.value || '';
        const nextMap = { arc:'bible', bible:'chars', chars:'outline', outline:'write' };
        try {
            await API.confirmPhase(this.currentProjectId, insp || null);
            this._updatePipelineBadge(step, 'done');
            if (nextMap[step]) this._updatePipelineBadge(nextMap[step], 'active');
            // Hide confirm bar
            const confirmEl = document.getElementById(`${step}-confirm-area`);
            if (confirmEl) confirmEl.style.display = 'none';
        } catch (err) { alert(`确认失败: ${err.message}`); }
    },

    /** Retry a failed phase (e.g. mini_arc_outline). */
    async retryPhase(phase) {
        if (!this.currentProjectId) return;
        // Handle topic_selection UI reset
        if (phase === 'topic_selection') {
            document.getElementById('topic-candidates-area').style.display = 'none';
            document.getElementById('topic-synopsis-cards').style.display = 'none';
            document.getElementById('topic-confirm-area').style.display = 'none';
            const aiArea = document.getElementById('topic-ai-area');
            if (aiArea) {
                aiArea.style.display = 'block';
                aiArea.querySelector('p').innerHTML = '<span style="color:var(--accent)">🔄 正在重新生成候选题材，这可能需要1-2分钟...</span>';
            }
            this._updatePipelineBadge('topic', 'running');
        }
        const resultEl = document.getElementById(`${phase === 'mini_arc_outline' ? 'arc' : phase}-result-area`);
        if (resultEl) resultEl.innerHTML = '<p style="color:var(--accent)">🔄 正在重新生成...</p>';
        // Pick up any inspiration the user added
        const inspEl = document.getElementById(`${phase === 'mini_arc_outline' ? 'arc' : phase}-inspiration`);
        const insp = inspEl?.value?.trim() || '';
        try {
            await API.retryPhase(this.currentProjectId, phase, insp || null);
        } catch (err) {
            alert(`重试失败: ${err.message}`);
        }
    },
};

document.addEventListener('DOMContentLoaded', () => App.init());
