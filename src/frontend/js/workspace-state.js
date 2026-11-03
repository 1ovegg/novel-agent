/** Per-project UI drafts survive navigation and browser refreshes. */
class WorkspaceStateStore {
    constructor(storage, prefix = 'novel-agent.workspace.v1') {
        this.storage = storage;
        this.prefix = prefix;
    }
    read(projectId) {
        try { return JSON.parse(this.storage.getItem(`${this.prefix}.${projectId || 'draft'}`) || 'null'); }
        catch { return null; }
    }
    save(projectId, value) {
        try { this.storage.setItem(`${this.prefix}.${projectId || 'draft'}`, JSON.stringify(value)); }
        catch { /* Storage limits must never interrupt creation. */ }
    }
    active() {
        try { return this.storage.getItem(`${this.prefix}.active`) || null; }
        catch { return null; }
    }
    remove(projectId) {
        try {
            this.storage.removeItem(`${this.prefix}.${projectId}`);
            if (this.active() === projectId) this.setActive(null);
        } catch { /* Storage may be unavailable. */ }
    }
    setActive(projectId) {
        try {
            if (projectId) this.storage.setItem(`${this.prefix}.active`, projectId);
            else this.storage.removeItem(`${this.prefix}.active`);
        } catch { /* Storage may be unavailable. */ }
    }
}
if (typeof module !== 'undefined') module.exports = WorkspaceStateStore;
