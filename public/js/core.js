// Shared UI core: API client, escaping, toasts, modal/drawer, group picker, charts.

export const state = { status: { status: 'disconnected' }, groups: [], communities: [] };

export async function api(method, path, body, { form = false } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
        if (form) opts.body = body;
        else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    const res = await fetch(`/api${path}`, opts);
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const data = isJson ? await res.json() : await res.text();
    if (res.status === 401 && path !== '/login') {
        window.dispatchEvent(new Event('auth:required'));
    }
    if (!res.ok) throw new Error((isJson && data.error) || `Request failed (${res.status})`);
    return data;
}

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const fmtNum = (n) => Number(n || 0).toLocaleString();
export const fmtDate = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const ago = (d) => {
    if (!d) return '—';
    const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
};

export function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : ''}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3800);
    setTimeout(() => el.remove(), 4200);
}

/** Wrap an async click handler: disables the button and toasts errors. */
export function action(btn, fn) {
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        btn.disabled = true;
        try { await fn(e); } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    });
}

// ---------- modal / drawer ----------

export function openModal(title, html) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal').classList.remove('hidden');
    return $('#modal-body');
}
export const closeModal = () => $('#modal').classList.add('hidden');

export function openDrawer(title, html) {
    $('#drawer-title').textContent = title;
    $('#drawer-body').innerHTML = html;
    $('#drawer').classList.remove('hidden');
    return $('#drawer-body');
}
export const closeDrawer = () => $('#drawer').classList.add('hidden');

// ---------- small components ----------

const HUES = [152, 174, 200, 258, 290, 330, 20, 38];
export function avatar(name) {
    const s = String(name || '?');
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const hue = HUES[h % HUES.length];
    const letter = [...s.trim()][0]?.toUpperCase() || '?';
    return `<span class="avatar" style="background:linear-gradient(135deg,hsl(${hue} 70% 62%),hsl(${(hue + 30) % 360} 70% 50%))">${esc(letter)}</span>`;
}

export function toggle(id, title, desc, checked) {
    return `<label class="toggle" for="${id}">
        <span class="toggle-text"><b>${esc(title)}</b>${desc ? `<span class="hint">${esc(desc)}</span>` : ''}</span>
        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="switch"></span>
    </label>`;
}

export function empty(icon, title, sub = '') {
    return `<div class="empty"><div class="big">${icon}</div><h3>${esc(title)}</h3><p>${esc(sub)}</p></div>`;
}

export function allTargets() {
    const list = [...state.groups];
    for (const c of state.communities) {
        for (const s of c.subgroups || []) if (!list.some((g) => g.jid === s.jid)) list.push(s);
    }
    return list.sort((a, b) => a.subject.localeCompare(b.subject));
}

/**
 * Searchable multi-select of groups. Empty selection can mean "all" (allLabel).
 * Returns { get(): string[] }.
 */
export function groupPicker(container, selected = [], { allLabel = null, adminOnly = false } = {}) {
    const groups = allTargets().filter((g) => !adminOnly || g.iAmAdmin);
    const sel = new Set(selected);
    container.innerHTML = `<div class="picker">
        <div class="picker-head">
            <input type="search" placeholder="Search groups…">
            <button type="button" class="btn btn-sm btn-ghost" data-all>All</button>
            <button type="button" class="btn btn-sm btn-ghost" data-none>None</button>
            <span class="picker-count"></span>
        </div>
        <div class="picker-list"></div>
    </div>`;
    const list = $('.picker-list', container);
    const count = $('.picker-count', container);
    const search = $('input[type=search]', container);

    const render = () => {
        const q = search.value.toLowerCase();
        const shown = groups.filter((g) => g.subject.toLowerCase().includes(q));
        list.innerHTML = shown.length ? shown.map((g) => `
            <label class="picker-item">
                <input type="checkbox" value="${esc(g.jid)}" ${sel.has(g.jid) ? 'checked' : ''}>
                <span class="grow">${esc(g.subject)}</span>
                ${g.isCommunityAnnounce ? '<span class="badge badge-violet">Announce</span>' : g.linkedParent ? '<span class="badge badge-violet">Community</span>' : ''}
                ${g.iAmAdmin ? '<span class="badge badge-ok">Admin</span>' : ''}
                <span class="hint">${fmtNum(g.size)}</span>
            </label>`).join('') : `<p class="hint" style="padding:10px">${groups.length ? 'No match' : 'No groups yet — connect WhatsApp first.'}</p>`;
        updateCount();
    };
    const updateCount = () => {
        count.textContent = sel.size ? `${sel.size} selected` : (allLabel || 'none selected');
    };
    list.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        e.target.checked ? sel.add(e.target.value) : sel.delete(e.target.value);
        updateCount();
    });
    search.addEventListener('input', render);
    $('[data-all]', container).addEventListener('click', () => {
        const q = search.value.toLowerCase();
        groups.filter((g) => g.subject.toLowerCase().includes(q)).forEach((g) => sel.add(g.jid));
        render();
    });
    $('[data-none]', container).addEventListener('click', () => { sel.clear(); render(); });
    render();
    return { get: () => [...sel] };
}

// ---------- charts (dependency-free SVG) ----------

export function lineChart(series, lines, { height = 220 } = {}) {
    const W = 700, H = height, P = { l: 36, r: 12, t: 12, b: 26 };
    const max = Math.max(1, ...series.flatMap((d) => lines.map((l) => d[l.key] || 0)));
    const x = (i) => P.l + (i * (W - P.l - P.r)) / Math.max(1, series.length - 1);
    const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
    const grid = [0, .25, .5, .75, 1].map((f) => {
        const v = Math.round(max * f);
        return `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="hsla(170,40%,70%,.08)"/>
                <text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }).join('');
    const step = Math.ceil(series.length / 7);
    const labels = series.map((d, i) => (i % step === 0 || i === series.length - 1)
        ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${d.date.slice(5)}</text>` : '').join('');
    const paths = lines.map((l, li) => {
        const pts = series.map((d, i) => `${x(i)},${y(d[l.key] || 0)}`);
        const id = `g${li}${Math.random().toString(36).slice(2, 7)}`;
        return `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stop-color="${l.color}" stop-opacity=".35"/><stop offset="1" stop-color="${l.color}" stop-opacity="0"/></linearGradient></defs>
                ${l.fill ? `<path d="M${pts[0]} L${pts.join(' L')} L${x(series.length - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#${id})"/>` : ''}
                <polyline points="${pts.join(' ')}" fill="none" stroke="${l.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}${labels}</svg>
            <div class="legend">${lines.map((l) => `<span style="--c:${l.color}">${esc(l.label)}</span>`).join('')}</div>`;
}

export function barList(items, { label, value, sub } = {}) {
    if (!items.length) return '<p class="hint">No data yet.</p>';
    const max = Math.max(1, ...items.map(value));
    return `<div class="bar-list">${items.map((it) => `
        <div class="bar-item">
            <div class="top"><span>${esc(label(it))}${sub ? ` <span class="hint">${esc(sub(it))}</span>` : ''}</span><b>${fmtNum(value(it))}</b></div>
            <div class="progress"><div style="width:${(value(it) / max) * 100}%"></div></div>
        </div>`).join('')}</div>`;
}

// ---------- message variable helpers ----------

export const STANDARD_VARS = [
    { key: '{group}', label: '{group}', desc: 'Group name' },
    { key: '{size}', label: '{size}', desc: 'Member count' },
    { key: '{date}', label: '{date}', desc: 'Current date' },
    { key: '{time}', label: '{time}', desc: 'Current time' },
    { key: '{day}', label: '{day}', desc: 'Day of week' },
    { key: '{desc}', label: '{desc}', desc: 'Group description' },
    { key: '{admins_count}', label: '{admins_count}', desc: 'Admins count' }
];

export function resolvePreviewVariables(template, meta, extraVars = {}) {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    const size = meta?.size ?? meta?.participants?.length ?? 0;
    const adminCount = (meta?.participants || []).filter((p) => p.admin).length || meta?.admins || 0;

    const baseVars = {
        group: meta?.subject || 'Sample Group',
        group_name: meta?.subject || 'Sample Group',
        name: meta?.subject || 'Sample Group',
        desc: meta?.desc || '(Group description)',
        description: meta?.desc || '(Group description)',
        size: String(size || 42),
        count: String(size || 42),
        members_count: String(size || 42),
        admins_count: String(adminCount || 2),
        date: now.toLocaleDateString(),
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        day: days[now.getDay()],
        month: months[now.getMonth()],
        year: String(now.getFullYear()),
        ...(extraVars || {})
    };

    return String(template || '').replace(/\{([a-zA-Z0-9_-]+)\}/g, (m, k) => {
        const val = baseVars[k] ?? baseVars[k.toLowerCase()];
        return val !== undefined ? String(val) : m;
    });
}

export function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const val = textarea.value;
    textarea.value = val.substring(0, start) + text + val.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

