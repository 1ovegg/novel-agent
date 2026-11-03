/** Read saved prose independently of generation; rendering never starts an AI task. */
const ChapterReader = {
    versions(chapter) {
        return [
            chapter.content ? {key:'final',label:'润色正文',text:chapter.content} : null,
            chapter.partial_polish ? {key:'partial',label:'润色中 · 已保存片段',text:chapter.partial_polish} : null,
            chapter.draft?.content ? {key:'draft',label:'初稿',text:chapter.draft.content} : null,
        ].filter(Boolean);
    },
    async refresh(app) {
        if (this.busy) return;
        const pid = app.currentProjectId;
        const select = document.getElementById('reader-project');
        const projectsKey = JSON.stringify(app._projects.map(p => [p.project_id,p.title]));
        if (select.dataset.key !== projectsKey) {
            select.innerHTML = '<option value="">请选择项目</option>' + app._projects.map(p => `<option value="${app._esc(p.project_id)}">${app._esc(p.title || '未命名')}</option>`).join('');
            select.dataset.key = projectsKey;
        }
        select.value = pid || '';
        if (this.pid !== pid) {
            this.pid = pid; this.chapter = null; this.version = null; this.data = null;
            document.getElementById('reader-content').textContent = '正在读取已保存内容……';
        }
        if (!pid) { document.getElementById('reader-chapters').textContent = '请先选择项目'; this.renderEmpty('请先选择一本书'); return; }
        this.busy = true;
        try {
            const chapters = await API.getChapters(pid);
            if (pid !== app.currentProjectId) return;
            if (!chapters.some(ch => ch.chapter_number === this.chapter)) {
                this.chapter = chapters.filter(ch => ch.has_content || ch.has_draft).at(-1)?.chapter_number || chapters[0]?.chapter_number;
            }
            const list = document.getElementById('reader-chapters');
            const key = JSON.stringify([pid,chapters,this.chapter]);
            if (list.dataset.key !== key) {
                list.innerHTML = chapters.map(ch => `<button class="reader-chapter ${ch.chapter_number === this.chapter ? 'selected' : ''}" ${ch.chapter_number === this.chapter ? 'aria-current="true"' : ''} onclick="ChapterReader.select(${ch.chapter_number},App)"><strong>第${ch.chapter_number}章 ${app._esc(ch.title)}</strong><span>${ch.has_content ? '润色正文' : ch.has_draft ? '初稿可读' : '等待正文'} · ${ch.word_count || 0} 字</span></button>`).join('') || '<p class="muted">尚无章节，生成后会自动出现。</p>';
                list.dataset.key = key;
            }
            if (!this.chapter) { this.renderEmpty('尚无已保存章节'); return; }
            const number = this.chapter;
            const data = await API.getChapter(pid,number);
            if (pid !== app.currentProjectId || number !== this.chapter) return;
            this.data = data;
            this.render(app);
            document.getElementById('reader-error').textContent = '';
        } catch (error) { document.getElementById('reader-error').textContent = `读取失败：${error.message}`; }
        finally { this.busy = false; }
    },
    select(number,app) { this.chapter = number; this.version = null; this.refresh(app); },
    changeVersion(version,app) { this.version = version; this.render(app); },
    renderEmpty(message) {
        document.getElementById('reader-title').textContent = message;
        document.getElementById('reader-content').textContent = '预览不会启动生成，已保存的初稿和润色内容都可以在这里阅读。';
        document.getElementById('reader-note').textContent = '';
        document.getElementById('reader-version').replaceChildren();
        document.getElementById('reader-version').dataset.key = '';
        document.getElementById('reader-version-label').textContent = '等待内容';
    },
    render(app) {
        const data = this.data;
        if (!data) return;
        const versions = this.versions(data);
        if (!versions.some(v => v.key === this.version)) this.version = versions[0]?.key;
        const selected = versions.find(v => v.key === this.version);
        const select = document.getElementById('reader-version');
        const key = JSON.stringify(versions.map(v => [v.key,v.label]));
        if (select.dataset.key !== key) {
            select.innerHTML = versions.map(v => `<option value="${v.key}">${v.label}</option>`).join('');
            select.dataset.key = key;
        }
        select.value = this.version || '';
        document.getElementById('reader-title').textContent = `第${data.chapter_number}章 ${data.plan?.title || data.draft?.title || ''}`;
        document.getElementById('reader-version-label').textContent = selected?.label || '尚无正文';
        const notes = [];
        if (this.version === 'draft') notes.push('这是已保存的初稿，后续审核和润色可能修改内容。');
        if (this.version === 'partial') notes.push(`仅展示已保存的 ${data.polish_progress?.completed}/${data.polish_progress?.total} 段，其余段落尚未完成。`);
        if (data.review?.review_complete === false) notes.push('本章部分审核未完成，请结合运行记录阅读，不代表审核通过。');
        notes.push('预览不会中断生成。');
        document.getElementById('reader-note').textContent = notes.join(' ');
        const target = document.getElementById('reader-content');
        const text = selected?.text || '本章已规划，正文尚未保存，请稍后查看。';
        if (target.textContent !== text) target.textContent = text;
    },
};
if (typeof module !== 'undefined') module.exports = ChapterReader;
