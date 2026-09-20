const API = {
    get: (url) => fetch(url, { method: 'GET' }).then(handle),
    post: (url, body) => fetch(url, { method: 'POST', body }).then(handle),
    postJson: (url, data) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(handle),
    putJson: (url, data) => fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(handle),
    del: (url) => fetch(url, { method: 'DELETE' }).then(handle),
};

async function handle(resp) {
    const data = await resp.json().catch(() => ({ code: -1, message: '响应解析失败' }));
    if (data.code !== 0) {
        const err = new Error(data.message || '请求失败');
        err.code = data.code;
        err.http = resp.status;
        throw err;
    }
    return data.data;
}

function toast(message, type = 'success', duration = 2500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
}

function confirmDialog(message) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop show';
        backdrop.innerHTML = `
            <div class="modal" style="max-width: 400px;">
                <div class="modal-title">确认</div>
                <p style="margin-bottom: 16px;">${message}</p>
                <div class="row" style="justify-content: flex-end; gap: 8px;">
                    <button class="btn" data-act="cancel">取消</button>
                    <button class="btn btn-danger" data-act="ok">确认</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.querySelector('[data-act="cancel"]').onclick = () => { backdrop.remove(); resolve(false); };
        backdrop.querySelector('[data-act="ok"]').onclick = () => { backdrop.remove(); resolve(true); };
        backdrop.onclick = (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } };
    });
}

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, s = bytes;
    while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
    return s.toFixed(2) + ' ' + units[i];
}

function formatDate(s) {
    return s || '-';
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function renderTags(tags) {
    return (tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
}