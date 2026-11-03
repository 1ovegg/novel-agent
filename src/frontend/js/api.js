/**
 * API client for Novel Agent backend.
 */
const API = {
    BASE: '/api',

    async request(method, path, body) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);
        const resp = await fetch(`${this.BASE}${path}`, opts);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        // Handle non-JSON responses (file downloads)
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('application/json')) return resp.json();
        if (ct.includes('text/')) return resp.text();
        return resp;
    },

    // ---- Projects ----
    createProject(config)       { return this.request('POST', '/projects', { config }); },
    listProjects()              { return this.request('GET', '/projects'); },
    getProject(id)              { return this.request('GET', `/projects/${id}`); },
    getWorkspace(id)            { return this.request('GET', `/projects/${id}/workspace`); },
    manualTopic(id)             { return this.request('POST', `/projects/${id}/manual-topic`); },
    pauseGeneration(id)         { return this.request('POST', `/projects/${id}/pause`); },
    resumeGeneration(id)        { return this.request('POST', `/projects/${id}/resume`); },
    deleteProject(id)           { return this.request('DELETE', `/projects/${id}`); },
    restoreProject(archiveId)   { return this.request('POST', `/trash/${archiveId}/restore`); },
    updateTitle(id, title)      { return this.request('PUT', `/projects/${id}/title`, { title }); },
    startWorkflow(id, options)  { return this.request('POST', `/projects/${id}/start`, options); },
    confirmPhase(id, inspiration, selected_topic) { return this.request('POST', `/projects/${id}/confirm-phase`, { inspiration, selected_topic }); },
    dailyRankings()            { return this.request('GET', '/rankings/today'); },
    refreshRankings()          { return this.request('POST', '/rankings/refresh'); },
    retryPreparedTopics()     { return this.request('POST', '/rankings/topics/refresh'); },
    runtime(id)                { return this.request('GET', `/runtime${id ? '?project_id=' + encodeURIComponent(id) : ''}`); },
    agentCall(id, callId)       { return this.request('GET', `/projects/${encodeURIComponent(id)}/agent-calls/${encodeURIComponent(callId)}`); },
    agentCalls(id, agent)       { return this.request('GET', `/projects/${encodeURIComponent(id)}/agent-calls?agent=${encodeURIComponent(agent)}`); },
    suggestTitles(inspiration, genre) { return this.request('POST', '/projects/suggest-titles', { inspiration, genre }); },
    submitScan(id, feiluHtml, fanqieHtml) { return this.request('POST', `/projects/${id}/submit-scan`, { feilu_html: feiluHtml||null, fanqie_html: fanqieHtml||null }); },
    autoScan(id)                { return this.request('POST', `/projects/${id}/auto-scan`); },
    retryPhase(id, phase, inspiration) { return this.request('POST', `/projects/${id}/retry-phase/${phase}`, { inspiration: inspiration || null }); },
    generateSynopsis(id, genreName, inspiration) { return this.request('POST', `/projects/${id}/generate-synopsis`, { genre_name: genreName, inspiration: inspiration || '' }); },

    // ---- Artifacts ----
    getBible(id)                { return this.request('GET', `/projects/${id}/bible`); },
    getCharacters(id)           { return this.request('GET', `/projects/${id}/characters`); },
    getOutline(id)              { return this.request('GET', `/projects/${id}/outline`); },
    getChapters(id)             { return this.request('GET', `/projects/${id}/chapters`); },
    getChapter(id, num)         { return this.request('GET', `/projects/${id}/chapters/${num}`); },
    deleteChapter(id, num)      { return this.request('DELETE', `/projects/${id}/chapters/${num}`); },
    getMemory(id)               { return this.request('GET', `/projects/${id}/memory`); },

    // ---- Edit / Save ----
    updateBibleSection(id, sectionId, value) { return this.request('PUT', `/projects/${id}/edit-section`, { section: sectionId, value }); },
    updateCharacterSection(id, sectionId, value) { return this.request('PUT', `/projects/${id}/edit-section`, { section: sectionId, value }); },
    updateOutlineSection(id, sectionId, value) { return this.request('PUT', `/projects/${id}/edit-section`, { section: sectionId, value }); },

    // ---- Export ----
    getChapterMdUrl(id, num)    { return `${this.BASE}/projects/${id}/chapters/${num}/md`; },
    getExportMdUrl(id)          { return `${this.BASE}/projects/${id}/export/markdown`; },
    getExportDocxUrl(id)        { return `${this.BASE}/projects/${id}/export/docx`; },

    // ---- Human Decision ----
    submitDecision(id, decision, feedback, rollbackTarget) {
        return this.request('POST', `/projects/${id}/human-decision`, {
            decision, feedback, rollback_target: rollbackTarget,
        });
    },
};
