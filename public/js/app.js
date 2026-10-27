import {
    state, api, esc, $, $$, fmtNum, fmtDate, ago, toast, action, openModal, closeModal, openDrawer, closeDrawer,
    avatar, toggle, empty, groupPicker, allTargets, lineChart, barList,
    STANDARD_VARS, resolvePreviewVariables, insertAtCursor
} from './core.js';

const page = $('#page');
const actions = $('#page-actions');
let socket = null;
let current = null;
const jobs = new Map();

// ====================================================================
// boot / auth
// ====================================================================

async function boot() {
    try {
        state.status = await api('GET', '/status');
        showApp();
    } catch {
        showLogin();
    }
}

function showLogin() {
    socket?.disconnect(); socket = null;
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#login-password').focus();
}

async function showApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    connectSocket();
    updatePill();
    await loadGroups().catch(() => { });
    api('GET', '/chats').then((c) => { chatListData = c; updateUnreadTotalBadge(); }).catch(() => { });
    route();
}

$('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
        await api('POST', '/login', { password: $('#login-password').value });
        $('#login-password').value = '';
        state.status = await api('GET', '/status');
        showApp();
    } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').addEventListener('click', async () => { await api('POST', '/logout').catch(() => { }); showLogin(); });
window.addEventListener('auth:required', showLogin);
$('#modal-close').addEventListener('click', closeModal);
$('#drawer-close').addEventListener('click', closeDrawer);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });

// ====================================================================
// realtime
// ====================================================================

let groupsReload = null;
function connectSocket() {
    if (socket) return;
    socket = window.io({ withCredentials: true });
    socket.on('wa:status', (s) => {
        const was = state.status.status;
        state.status = s;
        updatePill();
        if (current === 'dashboard') renderConnect();
        if (was !== 'connected' && s.status === 'connected') { toast('WhatsApp connected ✅'); loadGroups().then(rerenderIfGroupPage); }
    });
    socket.on('groups:changed', () => {
        clearTimeout(groupsReload);
        groupsReload = setTimeout(() => loadGroups().then(rerenderIfGroupPage).catch(() => { }), 500);
    });
    socket.on('job', (job) => {
        jobs.set(job.id, job);
        $$(`[data-job="${job.id}"]`).forEach((el) => renderJob(el, job));
        if (job.status === 'done') toast(`Job finished: ${job.results.filter((r) => r.ok).length}/${job.total} succeeded`);
        if (job.status === 'failed') toast(`Job failed: ${job.error}`, 'error');
    });
    socket.on('broadcast', (b) => { if (current === 'broadcasts') updateBroadcastRow(b); });
    socket.on('chat:message', (m) => handleSocketChatMessage(m));
    socket.on('chat:read', (r) => handleSocketChatRead(r?.chatJid));
}

function rerenderIfGroupPage() {
    if (['groups', 'communities', 'chats'].includes(current) && $('#modal').classList.contains('hidden')) route();
}

async function loadGroups() {
    const data = await api('GET', '/groups');
    state.groups = data.groups;
    state.communities = data.communities;
}

function updatePill() {
    const s = state.status.status;
    const map = {
        connected: ['pill-ok', `Connected${state.status.me?.name ? ' · ' + state.status.me.name : ''}`],
        qr: ['pill-warn', 'Scan QR code'],
        connecting: ['pill-warn', 'Connecting…'],
        disconnected: ['pill-muted', 'Disconnected']
    };
    const [cls, text] = map[s] || map.disconnected;
    const pill = $('#conn-pill');
    pill.className = `pill ${cls}`;
    pill.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
}

const requireConnected = () => {
    if (state.status.status !== 'connected') {
        return `<div class="card glass">${empty('📵', 'WhatsApp is not connected', 'Go to the Dashboard and scan the QR code to link your WhatsApp account.')}
            <div class="actions" style="justify-content:center"><a class="btn btn-primary" href="#/dashboard">Open Dashboard</a></div></div>`;
    }
    return '';
};

// ====================================================================
// router
// ====================================================================

const routes = {
    chats: ['Chats', renderChats],
    groups: ['Groups', renderGroups],
    communities: ['Communities', renderCommunities],
    broadcasts: ['Broadcasts', renderBroadcasts],
    'auto-replies': ['Auto-Replies', renderAutoReplies],
    moderation: ['Moderation', renderModeration],
    welcome: ['Welcome / Goodbye', renderWelcome],
    leads: ['Leads', renderLeads],
    analytics: ['Analytics', renderAnalytics],
    dashboard: ['Dashboard / Device', renderDashboard]
};

async function route() {
    const raw = (location.hash.replace(/^#\/?/, '').split('?')[0]);
    const key = raw || 'chats';
    const [title, render] = routes[key] || routes.chats;
    current = routes[key] ? key : 'chats';
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === current));
    $('#page-title').textContent = title;
    document.title = `${title} · WA-Groups`;
    actions.innerHTML = '';
    page.innerHTML = '<div class="skeleton"></div>';
    page.style.animation = 'none'; void page.offsetWidth; page.style.animation = '';
    try { await render(); } catch (err) { page.innerHTML = `<div class="card glass">${empty('⚠️', 'Something went wrong', err.message)}</div>`; }
}
window.addEventListener('hashchange', route);

// ====================================================================
// WhatsApp Web Chats
// ====================================================================

let chatListData = [];
let activeChatJid = null;
let activeChatMessages = [];
let chatFilter = 'all';
let chatSearch = '';

const SENDER_COLORS = [
    'hsl(174, 80%, 65%)',
    'hsl(42, 95%, 65%)',
    'hsl(280, 80%, 75%)',
    'hsl(190, 90%, 65%)',
    'hsl(330, 85%, 70%)',
    'hsl(120, 65%, 65%)',
    'hsl(25, 95%, 68%)'
];

function getSenderColor(str) {
    if (!str) return SENDER_COLORS[0];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return SENDER_COLORS[hash % SENDER_COLORS.length];
}

function updateUnreadTotalBadge() {
    const total = chatListData.reduce((sum, c) => sum + (c.unread || 0), 0);
    const badge = $('#unread-total-badge');
    if (badge) {
        badge.textContent = total;
        badge.classList.toggle('hidden', total === 0);
    }
}

function formatChatTime(ts) {
    if (!ts) return '';
    const date = new Date(ts);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
    }
    const diffDays = Math.floor((now - date) / 86400000);
    if (diffDays < 7) {
        return date.toLocaleDateString([], { weekday: 'short' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function handleSocketChatMessage(msg) {
    let chat = chatListData.find((c) => c.jid === msg.chatJid);
    if (!chat) {
        const all = allTargets();
        const found = all.find((g) => g.jid === msg.chatJid);
        chat = {
            jid: msg.chatJid,
            subject: found?.subject || msg.chatJid.split('@')[0],
            desc: found?.desc || '',
            size: found?.size || 0,
            isCommunity: !!found?.isCommunity,
            isCommunityAnnounce: !!found?.isCommunityAnnounce,
            announce: !!found?.announce,
            iAmAdmin: found?.iAmAdmin || false,
            unread: 0,
            lastMessage: null
        };
        chatListData.unshift(chat);
    }

    chat.lastMessage = {
        id: msg.id,
        text: msg.text,
        fromMe: msg.fromMe,
        senderName: msg.senderName,
        timestamp: msg.timestamp,
        hasMedia: !!msg.media
    };

    if (msg.chatJid !== activeChatJid && !msg.fromMe) {
        chat.unread = (chat.unread || 0) + 1;
    }

    const idx = chatListData.findIndex((c) => c.jid === msg.chatJid);
    if (idx > 0) {
        const [c] = chatListData.splice(idx, 1);
        chatListData.unshift(c);
    }

    updateUnreadTotalBadge();

    if (current === 'chats') {
        drawChatList();
        if (msg.chatJid === activeChatJid) {
            if (!activeChatMessages.some((m) => m.id === msg.id)) {
                activeChatMessages.push(msg);
                drawMessagesList();
                api('POST', `/chats/${encodeURIComponent(msg.chatJid)}/read`).catch(() => { });
            }
        }
    }
}

function handleSocketChatRead(chatJid) {
    const chat = chatListData.find((c) => c.jid === chatJid);
    if (chat) {
        chat.unread = 0;
        updateUnreadTotalBadge();
        if (current === 'chats') {
            const badge = $(`[data-jid="${chatJid}"] .wa-unread-badge`);
            if (badge) badge.remove();
        }
    }
}

async function renderChats() {
    const notConn = requireConnected();
    if (notConn) { page.innerHTML = notConn; return; }

    chatListData = await api('GET', '/chats').catch(() => []);
    updateUnreadTotalBadge();

    const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
    const paramJid = hashParams.get('jid');
    if (paramJid && chatListData.some((c) => c.jid === paramJid)) {
        activeChatJid = paramJid;
    }

    page.innerHTML = `
        <div class="wa-container">
            <div class="wa-sidebar">
                <div class="wa-sidebar-header">
                    <div class="wa-sidebar-top">
                        <span class="wa-sidebar-title">Chats</span>
                        <div class="actions" style="gap:4px">
                            <button id="wa-btn-refresh-chats" class="btn btn-ghost btn-sm" title="Refresh chats">🔄</button>
                            <a href="#/groups" class="btn btn-ghost btn-sm" title="Manage Groups">👥</a>
                        </div>
                    </div>
                    <div class="wa-search-box">
                        <span class="wa-search-icon">🔍</span>
                        <input type="text" id="wa-chat-search" placeholder="Search chats or messages…" value="${esc(chatSearch)}">
                    </div>
                    <div class="wa-filter-chips">
                        <button class="wa-filter-chip ${chatFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
                        <button class="wa-filter-chip ${chatFilter === 'groups' ? 'active' : ''}" data-filter="groups">Groups</button>
                        <button class="wa-filter-chip ${chatFilter === 'communities' ? 'active' : ''}" data-filter="communities">Communities</button>
                        <button class="wa-filter-chip ${chatFilter === 'unread' ? 'active' : ''}" data-filter="unread">Unread</button>
                    </div>
                </div>
                <div class="wa-chat-list" id="wa-chat-list"></div>
            </div>

            <div class="wa-conversation" id="wa-conv-pane"></div>
        </div>
    `;

    $('#wa-btn-refresh-chats')?.addEventListener('click', async () => {
        chatListData = await api('GET', '/chats').catch(() => []);
        drawChatList();
        updateUnreadTotalBadge();
        toast('Chats updated');
    });

    $('#wa-chat-search')?.addEventListener('input', (e) => {
        chatSearch = e.target.value.trim().toLowerCase();
        drawChatList();
    });

    $$('.wa-filter-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
            $$('.wa-filter-chip').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            chatFilter = btn.dataset.filter;
            drawChatList();
        });
    });

    drawChatList();
    if (activeChatJid) {
        selectChat(activeChatJid);
    } else {
        drawEmptyConv();
    }
}

function drawChatList() {
    const listEl = $('#wa-chat-list');
    if (!listEl) return;

    const filtered = chatListData.filter((c) => {
        if (chatFilter === 'groups' && c.isCommunity) return false;
        if (chatFilter === 'communities' && !c.isCommunity && !c.isCommunityAnnounce) return false;
        if (chatFilter === 'unread' && (!c.unread || c.unread <= 0)) return false;
        if (chatSearch) {
            const matchName = (c.subject || '').toLowerCase().includes(chatSearch);
            const matchMsg = (c.lastMessage?.text || '').toLowerCase().includes(chatSearch);
            if (!matchName && !matchMsg) return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `<div style="padding:40px 16px;text-align:center;color:var(--muted);font-size:13px">
            <div style="font-size:32px;margin-bottom:8px">🔍</div>
            No chats match filter
        </div>`;
        return;
    }

    listEl.innerHTML = filtered.map((c) => {
        const isActive = c.jid === activeChatJid;
        const timeStr = c.lastMessage?.timestamp ? formatChatTime(c.lastMessage.timestamp) : '';
        const lastSnippet = c.lastMessage
            ? (c.lastMessage.fromMe ? '<span class="wa-checkmarks">✓✓</span> ' : (c.lastMessage.senderName ? esc(c.lastMessage.senderName) + ': ' : '')) + esc(c.lastMessage.text || (c.lastMessage.hasMedia ? '📷 Photo/Media' : ''))
            : '<span class="hint">No messages yet</span>';

        return `
            <div class="wa-chat-row ${isActive ? 'active' : ''}" data-jid="${esc(c.jid)}">
                <div class="wa-chat-avatar">
                    ${avatar(c.subject)}
                </div>
                <div class="wa-chat-info">
                    <div class="wa-chat-row-top">
                        <div class="wa-chat-name" title="${esc(c.subject)}">
                            ${c.isCommunity ? '🏘️ ' : ''}${esc(c.subject)}
                        </div>
                        <div class="wa-chat-time">${timeStr}</div>
                    </div>
                    <div class="wa-chat-row-bottom">
                        <div class="wa-chat-last-msg">${lastSnippet}</div>
                        ${c.unread > 0 ? `<span class="wa-unread-badge">${c.unread}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    $$('.wa-chat-row', listEl).forEach((row) => {
        row.addEventListener('click', () => {
            selectChat(row.dataset.jid);
        });
    });
}

function drawEmptyConv() {
    const pane = $('#wa-conv-pane');
    if (!pane) return;
    pane.innerHTML = `
        <div class="wa-empty-conv">
            <div class="wa-empty-icon">💬</div>
            <div class="wa-empty-title">WhatsApp Web for Groups & Communities</div>
            <div class="wa-empty-desc">
                Select a group or community from the left to view live incoming/outgoing messages, send updates with dynamic variables, and chat in real-time.
            </div>
            <div class="pill pill-ok"><span class="dot"></span><span>End-to-end encrypted Baileys engine active</span></div>
        </div>
    `;
}

async function selectChat(jid) {
    activeChatJid = jid;
    $$('.wa-chat-row').forEach((r) => r.classList.toggle('active', r.dataset.jid === jid));

    const chat = chatListData.find((c) => c.jid === jid);
    if (chat && chat.unread > 0) {
        chat.unread = 0;
        updateUnreadTotalBadge();
        const badge = $(`[data-jid="${jid}"] .wa-unread-badge`);
        if (badge) badge.remove();
        api('POST', `/chats/${encodeURIComponent(jid)}/read`).catch(() => { });
    }

    const pane = $('#wa-conv-pane');
    if (!pane) return;

    if (!chat) {
        drawEmptyConv();
        return;
    }

    pane.innerHTML = `
        <div class="wa-conv-header">
            <div class="wa-conv-header-left" id="wa-header-group-info" title="Click to view group details">
                ${avatar(chat.subject)}
                <div class="wa-conv-meta">
                    <div class="wa-conv-title">${chat.isCommunity ? '🏘️ ' : ''}${esc(chat.subject)}</div>
                    <div class="wa-conv-subtitle">
                        ${fmtNum(chat.size)} members${chat.isCommunity ? ' · Community' : (chat.isCommunityAnnounce ? ' · Announcements' : ' · Group')}${chat.iAmAdmin ? ' · Admin' : ''}
                    </div>
                </div>
            </div>
            <div class="wa-conv-actions">
                <button id="wa-btn-export" class="btn btn-ghost btn-sm" title="Export member list CSV">📥 CSV</button>
                <a href="#/broadcasts" class="btn btn-ghost btn-sm" title="Send broadcast">📣 Broadcast</a>
            </div>
        </div>

        <div class="wa-messages-container" id="wa-messages">
            <div class="wa-encryption-notice">
                🔒 Messages and calls are end-to-end encrypted. Connected via Baileys 7 linked session.
            </div>
            <div id="wa-messages-list" style="display:flex;flex-direction:column;gap:8px;">
                <div class="skeleton" style="height:60px"></div>
            </div>
        </div>

        <div class="wa-conv-footer">
            <div class="wa-composer-vars">
                <span class="hint" style="font-size:11px;margin-right:2px">Variables:</span>
                <button type="button" class="wa-composer-var-chip" data-var="{group}" title="Group name">{group}</button>
                <button type="button" class="wa-composer-var-chip" data-var="{size}" title="Member count">{size}</button>
                <button type="button" class="wa-composer-var-chip" data-var="{date}" title="Today's date">{date}</button>
                <button type="button" class="wa-composer-var-chip" data-var="{time}" title="Current time">{time}</button>
                <button type="button" class="wa-composer-var-chip" data-var="{day}" title="Current day">{day}</button>
                <button type="button" class="wa-composer-var-chip" data-var="{admins_count}" title="Number of admins">{admins_count}</button>
            </div>
            <div id="wa-attachment-preview" class="hidden"></div>
            <div class="wa-composer-input-row">
                <input type="file" id="wa-file-input" style="display:none">
                <button id="wa-attach-btn" class="btn btn-ghost" type="button" title="Attach file or photo" style="font-size:18px;padding:6px 10px">📎</button>
                <textarea id="wa-message-input" class="wa-composer-input" placeholder="Type a message or use variables… (Press Enter to send, Shift+Enter for new line)" rows="1"></textarea>
                <button id="wa-send-btn" class="wa-send-btn" type="button" title="Send message (Enter)">➤</button>
            </div>
        </div>
    `;

    activeChatMessages = await api('GET', `/chats/${encodeURIComponent(jid)}/messages`).catch(() => []);
    drawMessagesList();

    $('#wa-header-group-info')?.addEventListener('click', () => {
        openGroup(jid);
    });

    $('#wa-btn-export')?.addEventListener('click', () => {
        window.location.href = `/api/groups/${encodeURIComponent(jid)}/export`;
    });

    $$('.wa-composer-var-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const input = $('#wa-message-input');
            if (input) {
                insertAtCursor(input, chip.dataset.var);
                input.focus();
            }
        });
    });

    let attachedFile = null;
    const fileInput = $('#wa-file-input');
    const attachBtn = $('#wa-attach-btn');
    const previewEl = $('#wa-attachment-preview');

    attachBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
        if (fileInput.files?.[0]) {
            attachedFile = fileInput.files[0];
            previewEl.classList.remove('hidden');
            previewEl.innerHTML = `
                <div class="wa-attached-file-pill">
                    <span>📎 ${esc(attachedFile.name)} (${Math.round(attachedFile.size / 1024)} KB)</span>
                    <span class="remove-file" title="Remove attachment">×</span>
                </div>
            `;
            $('.remove-file', previewEl)?.addEventListener('click', () => {
                attachedFile = null;
                fileInput.value = '';
                previewEl.classList.add('hidden');
                previewEl.innerHTML = '';
            });
        }
    });

    const msgInput = $('#wa-message-input');
    const sendBtn = $('#wa-send-btn');

    msgInput?.focus();
    msgInput?.addEventListener('input', () => {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    });

    msgInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            doSend();
        }
    });

    sendBtn?.addEventListener('click', () => {
        doSend();
    });

    async function doSend() {
        const text = msgInput.value.trim();
        if (!text && !attachedFile) return;

        sendBtn.disabled = true;
        try {
            const formData = new FormData();
            if (text) formData.append('text', text);
            if (attachedFile) formData.append('media', attachedFile);

            const res = await api('POST', `/chats/${encodeURIComponent(jid)}/messages`, formData, { form: true });
            msgInput.value = '';
            msgInput.style.height = '42px';
            attachedFile = null;
            if (fileInput) fileInput.value = '';
            previewEl.classList.add('hidden');
            previewEl.innerHTML = '';

            if (res?.message) {
                activeChatMessages.push(res.message);
                drawMessagesList();
                chat.lastMessage = {
                    id: res.message.id,
                    text: res.message.text,
                    fromMe: true,
                    senderName: 'You',
                    timestamp: res.message.timestamp,
                    hasMedia: !!res.message.media
                };
                const idx = chatListData.findIndex((c) => c.jid === jid);
                if (idx > 0) {
                    const [c] = chatListData.splice(idx, 1);
                    chatListData.unshift(c);
                }
                drawChatList();
            }
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            sendBtn.disabled = false;
            msgInput.focus();
        }
    }
}

function drawMessagesList() {
    const listEl = $('#wa-messages-list');
    const container = $('#wa-messages');
    if (!listEl || !container) return;

    if (activeChatMessages.length === 0) {
        listEl.innerHTML = `
            <div style="padding:40px 16px;text-align:center;color:var(--muted);font-size:13px">
                <div style="font-size:36px;margin-bottom:8px">💬</div>
                No messages recorded in this chat yet.<br>
                Type a message below to start chatting!
            </div>
        `;
        return;
    }

    let lastDateStr = '';
    const html = [];

    for (const m of activeChatMessages) {
        const d = new Date(m.timestamp);
        const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
        if (dateStr !== lastDateStr) {
            lastDateStr = dateStr;
            const isToday = d.toDateString() === new Date().toDateString();
            const label = isToday ? 'Today' : dateStr;
            html.push(`<div class="wa-date-divider">${esc(label)}</div>`);
        }

        const isOutgoing = !!m.fromMe;
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const senderColor = getSenderColor(m.sender || m.senderName || '');

        let mediaHtml = '';
        if (m.media) {
            if (m.media.kind === 'image') {
                mediaHtml = `<div class="wa-bubble-media"><img src="${esc(m.media.url)}" alt="Media" loading="lazy"></div>`;
            } else if (m.media.kind === 'video') {
                mediaHtml = `<div class="wa-bubble-media"><video src="${esc(m.media.url)}" controls></video></div>`;
            } else if (m.media.kind === 'document') {
                mediaHtml = `<div class="wa-bubble-media" style="padding:8px;background:hsla(0,0%,0%,0.2);display:flex;align-items:center;gap:8px">
                    📄 <a href="${esc(m.media.url)}" target="_blank" style="color:var(--accent);word-break:break-all">${esc(m.media.fileName || 'Document')}</a>
                </div>`;
            }
        }

        html.push(`
            <div class="wa-bubble-wrap ${isOutgoing ? 'outgoing' : 'incoming'}">
                <div class="wa-bubble ${isOutgoing ? 'outgoing' : 'incoming'}">
                    ${!isOutgoing && m.senderName ? `<div class="wa-bubble-sender" style="color:${senderColor}">${esc(m.senderName)}</div>` : ''}
                    ${mediaHtml}
                    ${m.text ? `<div class="wa-bubble-text">${esc(m.text)}</div>` : ''}
                    <span class="wa-bubble-meta">
                        ${timeStr}
                        ${isOutgoing ? '<span class="wa-checkmarks">✓✓</span>' : ''}
                    </span>
                </div>
            </div>
        `);
    }

    listEl.innerHTML = html.join('');
    container.scrollTop = container.scrollHeight;
}

// ====================================================================
// dashboard
// ====================================================================

async function renderDashboard() {
    const a = await api('GET', '/analytics?days=14').catch(() => null);
    const t = a?.totals || { messages: 0, joins: 0, leaves: 0 };
    const all = allTargets();
    page.innerHTML = `
        <div id="connect-card" class="card glass"></div>
        <div class="stats">
            ${stat('👥', 'Groups', fmtNum(state.groups.length), 'var(--accent)')}
            ${stat('🏘️', 'Communities', fmtNum(state.communities.length), 'var(--violet)')}
            ${stat('🛡️', 'Admin in', fmtNum(all.filter((g) => g.iAmAdmin).length), 'var(--accent-2)')}
            ${stat('📇', 'Leads captured', fmtNum(a?.leadCount), 'var(--amber)')}
            ${stat('💬', 'Messages · 14d', fmtNum(t.messages), 'var(--accent)')}
            ${stat('📈', 'Net growth · 14d', (t.joins - t.leaves >= 0 ? '+' : '') + fmtNum(t.joins - t.leaves), 'var(--violet)')}
        </div>
        <div class="grid-2">
            <div class="card glass"><div class="card-head"><h2>Group activity</h2><a href="#/analytics" class="btn btn-sm btn-ghost">Details →</a></div>
                ${a ? lineChart(a.series, [{ key: 'messages', label: 'Messages', color: 'hsl(152 68% 47%)', fill: true }]) : '<p class="hint">No data yet.</p>'}</div>
            <div class="card glass"><div class="card-head"><h2>Most active groups</h2></div>
                ${barList((a?.topGroups || []).filter((g) => g.messages).slice(0, 6), { label: (g) => g.subject, value: (g) => g.messages })}</div>
        </div>`;
    renderConnect();
}

const stat = (icon, label, value, color) =>
    `<div class="stat glass" style="--c:${color}"><span class="icon">${icon}</span><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;

function renderConnect() {
    const el = $('#connect-card');
    if (!el) return;
    const s = state.status;
    let right = '';
    let left = '';
    if (s.status === 'connected') {
        left = `<h2>✅ WhatsApp connected</h2>
            <p class="muted">Signed in as <b>${esc(s.me?.name || '')}</b> <span class="mono">${esc((s.me?.id || '').split(':')[0].split('@')[0])}</span>.
            Automations are live for ${fmtNum(s.groupCount)} groups and ${fmtNum(s.communityCount)} communities.</p>
            <div class="actions" style="justify-content:flex-start;margin-top:12px">
                <button id="btn-refresh" class="btn">🔄 Re-sync groups</button>
                <button id="btn-wa-logout" class="btn btn-danger">Unlink device</button>
            </div>`;
        right = '<div class="qr-placeholder" style="border-style:solid;font-size:64px">📱</div>';
    } else {
        left = `<h2>Link your WhatsApp</h2>
            <p class="muted">Group & community automation works through WhatsApp's <b>Linked Devices</b> (QR login).</p>
            <ol><li>Open WhatsApp on your phone</li><li>Tap <b>⋮ / Settings → Linked devices → Link a device</b></li><li>Scan the QR code shown here</li></ol>
            <div class="actions" style="justify-content:flex-start;margin-top:14px">
                <button id="btn-connect" class="btn btn-primary">${s.status === 'qr' ? '↻ New QR code' : '⚡ Generate QR code'}</button>
            </div>
            ${s.reason === 'reconnect_failed' ? '<p class="error-text">Could not reconnect automatically. Generate a new QR code.</p>' : ''}
            <p class="hint" style="margin-top:12px">Tip: use a dedicated number. Mass-messaging from a fresh number can get it banned by WhatsApp.</p>`;
        right = s.status === 'qr' && s.qr
            ? `<div class="qr-box"><img src="${esc(s.qr)}" alt="WhatsApp QR code"></div>`
            : `<div class="qr-placeholder"><div>${s.status === 'connecting' ? '<div class="spinner"></div>Connecting…' : 'QR code will appear here'}</div></div>`;
    }
    el.innerHTML = `<div class="connect"><div>${left}</div>${right}</div>`;
    const c = $('#btn-connect', el);
    if (c) action(c, async () => { await api('POST', '/wa/connect', { force: true }); });
    const r = $('#btn-refresh', el);
    if (r) action(r, async () => { const d = await api('POST', '/wa/refresh'); state.groups = d.groups; state.communities = d.communities; toast('Groups re-synced'); renderDashboard(); });
    const lo = $('#btn-wa-logout', el);
    if (lo) action(lo, async () => { if (confirm('Unlink this WhatsApp account? Automations will stop.')) await api('POST', '/wa/logout'); });
}

// ====================================================================
// message composer with variable replacement
// ====================================================================

function renderMessageComposerHtml({ idPrefix, showPicker = true, showSchedule = true, defaultText = '' }) {
    return `
        <div class="form" id="${idPrefix}-form">
            ${showSchedule ? `
            <div class="row">
                <label class="field"><span>Campaign / Note</span><input name="name" maxlength="100" placeholder="e.g. Announcement to Groups"></label>
                <label class="field"><span>Send at</span><input name="scheduleAt" type="datetime-local"><span class="hint">Leave empty to send immediately</span></label>
                <label class="field"><span>Repeat</span><select name="repeat"><option value="none">Once</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label>
            </div>` : ''}

            <label class="field">
                <span>Message</span>
                <textarea name="text" id="${idPrefix}-text" rows="5" maxlength="4096" placeholder="Hi everyone in *{group}*! We currently have {size} members. Today is {day}, {date}.">${esc(defaultText)}</textarea>
            </label>

            <div class="var-chips-wrap">
                <div class="var-chips-label">
                    <span>Click variable to insert:</span>
                    <span class="hint">Substituted automatically per group</span>
                </div>
                <div class="var-chips" id="${idPrefix}-chips">
                    ${STANDARD_VARS.map((v) => `<button type="button" class="var-chip" data-var="${esc(v.key)}" title="${esc(v.desc)}">${esc(v.label)}</button>`).join('')}
                </div>
            </div>

            <div style="margin-top:4px">
                <details>
                    <summary class="hint" style="cursor:pointer;user-select:none;font-weight:500">＋ Add custom variables (e.g. {offer}, {zoom_link})</summary>
                    <div class="custom-vars-box" id="${idPrefix}-cv-box">
                        <div id="${idPrefix}-cv-list" style="display:grid;gap:6px"></div>
                        <div><button type="button" class="btn btn-sm btn-ghost" id="${idPrefix}-cv-add">＋ Add variable</button></div>
                    </div>
                </details>
            </div>

            <div id="${idPrefix}-preview"></div>

            <label class="field"><span>Attachment (optional)</span><input name="media" id="${idPrefix}-media" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"></label>
            ${toggle(`${idPrefix}-mention`, 'Silently mention everyone', 'Notifies all members even if they muted the group (use sparingly).', false)}

            ${showPicker ? `<label class="field"><span>Target groups</span><div id="${idPrefix}-picker"></div></label>` : ''}
        </div>
    `;
}

function bindMessageComposer({ root, idPrefix, getTargets }) {
    const textarea = $(`#${idPrefix}-text`, root);
    const chips = $$(`#${idPrefix}-chips .var-chip`, root);
    const previewEl = $(`#${idPrefix}-preview`, root);
    const cvList = $(`#${idPrefix}-cv-list`, root);
    const cvAdd = $(`#${idPrefix}-cv-add`, root);

    const getCustomVars = () => {
        const obj = {};
        if (cvList) {
            $$('.custom-var-row', cvList).forEach((row) => {
                const k = $('input[data-k]', row)?.value.trim().replace(/^\{|\}$/g, '');
                const v = $('input[data-v]', row)?.value;
                if (k) obj[k] = v;
            });
        }
        return obj;
    };

    const updatePreview = () => {
        if (!textarea || !previewEl) return;
        const text = textarea.value;
        const targets = typeof getTargets === 'function' ? getTargets() : [];
        const firstJid = targets[0];
        const all = allTargets();
        const sampleMeta = all.find((g) => g.jid === firstJid) || all[0] || { subject: 'Sample Group', size: 100, desc: 'Group description' };
        const resolved = resolvePreviewVariables(text, sampleMeta, getCustomVars());

        previewEl.innerHTML = `
            <div class="preview-box">
                <div class="preview-title">
                    <span>Message Preview ${sampleMeta.subject ? `(${esc(sampleMeta.subject)})` : ''}</span>
                    <span class="hint">${targets.length ? `${targets.length} group${targets.length > 1 ? 's' : ''} targeted` : 'Pick targets below'}</span>
                </div>
                <div>${text.trim() ? esc(resolved) : '<span class="hint">Type message above or click a variable chip…</span>'}</div>
            </div>`;
    };

    chips.forEach((btn) => {
        btn.addEventListener('click', () => {
            insertAtCursor(textarea, btn.dataset.var);
            updatePreview();
        });
    });

    textarea.addEventListener('input', updatePreview);

    if (cvAdd && cvList) {
        cvAdd.addEventListener('click', () => {
            const row = document.createElement('div');
            row.className = 'custom-var-row';
            row.innerHTML = `
                <input placeholder="Variable name (e.g. coupon)" data-k style="font-family:monospace">
                <input placeholder="Value (e.g. SAVE20)" data-v>
                <button type="button" class="btn btn-sm btn-danger" style="padding:6px 10px">✕</button>`;
            $('button', row).addEventListener('click', () => { row.remove(); updatePreview(); });
            $('input[data-k]', row).addEventListener('input', updatePreview);
            $('input[data-v]', row).addEventListener('input', updatePreview);
            cvList.appendChild(row);
        });
    }

    updatePreview();

    return { updatePreview, getCustomVars };
}

function sendMessageModal(preselectedJids = []) {
    const body = openModal('💬 Send Message with Variables to Selected Groups', `
        ${renderMessageComposerHtml({ idPrefix: 'modal-msg', showPicker: true, showSchedule: true })}
        <div class="actions" style="margin-top:16px">
            <button class="btn btn-ghost" id="btn-cancel-modal-msg">Cancel</button>
            <button class="btn btn-primary" id="btn-send-modal-msg">🚀 Send message</button>
        </div>
    `);

    $('#btn-cancel-modal-msg', body).addEventListener('click', closeModal);

    const picker = groupPicker($('#modal-msg-picker', body), preselectedJids);
    const { getCustomVars, updatePreview } = bindMessageComposer({
        root: body,
        idPrefix: 'modal-msg',
        getTargets: () => picker.get()
    });

    $('#modal-msg-picker', body).addEventListener('change', updatePreview);

    action($('#btn-send-modal-msg', body), async () => {
        const fd = new FormData();
        const targets = picker.get();
        if (!targets.length) throw new Error('Please select at least one target group');
        const text = $('#modal-msg-text', body).value;
        const file = $('#modal-msg-media', body).files[0];
        if (!text.trim() && !file) throw new Error('Write a message or attach a file');

        const nameInput = $('input[name=name]', body);
        const name = nameInput?.value || `Message to ${targets.length} groups (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
        const scheduleAtInput = $('input[name=scheduleAt]', body);
        const at = scheduleAtInput?.value ? new Date(scheduleAtInput.value).toISOString() : null;
        const repeat = $('select[name=repeat]', body)?.value || 'none';

        fd.set('name', name);
        fd.set('text', text);
        fd.set('targets', JSON.stringify(targets));
        fd.set('customVars', JSON.stringify(getCustomVars()));
        fd.set('mentionAll', $(`#modal-msg-mention`, body).checked);
        fd.set('repeat', repeat);
        if (at) fd.set('scheduleAt', at);
        if (file) fd.set('media', file);

        await api('POST', '/broadcasts', fd, { form: true });
        closeModal();
        toast(at ? 'Message scheduled 🗓️' : 'Sending message to selected groups 🚀');
        if (current === 'broadcasts') renderBroadcasts();
    });
}

// ====================================================================
// groups
// ====================================================================

let groupFilter = { q: '', admin: false };
let selectedGroupJids = new Set();

async function renderGroups() {
    const blocked = requireConnected();
    if (blocked) { page.innerHTML = blocked; return; }
    actions.innerHTML = `
        <button id="btn-msg-groups" class="btn btn-primary">💬 Message groups</button>
        <button id="btn-join" class="btn">🔗 Join via link</button>
        <button id="btn-bulk-create" class="btn">📚 Bulk create</button>
        <button id="btn-create" class="btn">＋ New group</button>`;
    action($('#btn-msg-groups'), () => sendMessageModal([...selectedGroupJids]));
    action($('#btn-create'), () => createGroupModal());
    action($('#btn-bulk-create'), () => bulkCreateModal());
    action($('#btn-join'), () => joinModal());

    page.innerHTML = `
        <div class="toolbar">
            <input id="group-search" type="search" placeholder="Search ${fmtNum(state.groups.length)} groups…" value="${esc(groupFilter.q)}">
            <label class="picker-item" style="width:auto"><input id="group-admin" type="checkbox" ${groupFilter.admin ? 'checked' : ''}> Only where I'm admin</label>
            <button id="btn-msg-selected-bar" class="btn btn-sm btn-primary ${selectedGroupJids.size ? '' : 'hidden'}">💬 Message selected (<span id="sel-count">${selectedGroupJids.size}</span>)</button>
            <button id="btn-clear-selection" class="btn btn-sm btn-ghost ${selectedGroupJids.size ? '' : 'hidden'}">Clear selection</button>
            <button id="btn-export-all" class="btn btn-sm btn-ghost" style="margin-left:auto">⬇ Export leads</button>
        </div>
        <div id="group-grid" class="group-grid"></div>`;

    $('#btn-export-all').addEventListener('click', () => { location.href = '/api/leads/export'; });
    $('#btn-msg-selected-bar').addEventListener('click', () => sendMessageModal([...selectedGroupJids]));
    $('#btn-clear-selection').addEventListener('click', () => {
        selectedGroupJids.clear();
        updateSelectionUi();
        draw();
    });

    const updateSelectionUi = () => {
        const count = selectedGroupJids.size;
        const msgBtn = $('#btn-msg-selected-bar');
        const clearBtn = $('#btn-clear-selection');
        const countSpan = $('#sel-count');
        if (msgBtn && clearBtn && countSpan) {
            countSpan.textContent = count;
            msgBtn.classList.toggle('hidden', count === 0);
            clearBtn.classList.toggle('hidden', count === 0);
        }
    };

    const draw = () => {
        const q = groupFilter.q.toLowerCase();
        const list = state.groups.filter((g) => g.subject.toLowerCase().includes(q) && (!groupFilter.admin || g.iAmAdmin));
        $('#group-grid').innerHTML = list.length ? list.map(groupCard).join('') : empty('👥', 'No groups found', 'Create one or change the filters.');
        
        $$('#group-grid [data-jid]').forEach((c) => {
            c.addEventListener('click', (e) => {
                if (e.target.dataset.chk) return;
                openGroup(c.dataset.jid);
            });
        });

        $$('#group-grid [data-chk]').forEach((chk) => {
            chk.addEventListener('change', (e) => {
                e.stopPropagation();
                const jid = e.target.dataset.chk;
                if (e.target.checked) selectedGroupJids.add(jid);
                else selectedGroupJids.delete(jid);
                updateSelectionUi();
            });
        });
    };

    $('#group-search').addEventListener('input', (e) => { groupFilter.q = e.target.value; draw(); });
    $('#group-admin').addEventListener('change', (e) => { groupFilter.admin = e.target.checked; draw(); });
    draw();
}

function groupCard(g) {
    const parent = g.linkedParent && state.communities.find((c) => c.jid === g.linkedParent);
    const checked = selectedGroupJids.has(g.jid);
    return `<article class="group-card glass" data-jid="${esc(g.jid)}" tabindex="0">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <h3 style="margin:0">${avatar(g.subject)}<span>${esc(g.subject)}</span></h3>
            <input type="checkbox" data-chk="${esc(g.jid)}" ${checked ? 'checked' : ''} style="width:auto;cursor:pointer;accent-color:var(--accent)" title="Select for messaging">
        </div>
        <div class="meta-row">
            <span class="badge">👤 ${fmtNum(g.size)}</span>
            ${g.iAmAdmin ? '<span class="badge badge-ok">Admin</span>' : ''}
            ${g.announce ? '<span class="badge badge-amber">Admins-only chat</span>' : ''}
            ${g.isCommunityAnnounce ? '<span class="badge badge-violet">Announcements</span>' : ''}
            ${parent ? `<span class="badge badge-violet">🏘️ ${esc(parent.subject)}</span>` : ''}
        </div>
        ${g.desc ? `<p class="hint" style="margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(g.desc)}</p>` : ''}
    </article>`;
}

function createGroupModal(communityJid = null) {
    const comm = communityJid && state.communities.find((c) => c.jid === communityJid);
    const body = openModal(comm ? `New group in ${comm.subject}` : 'Create a group', `
        <form class="form" id="f-create">
            <label class="field"><span>Group name</span><input name="subject" maxlength="100" required></label>
            <label class="field"><span>Description</span><textarea name="description" maxlength="2048"></textarea></label>
            <label class="field"><span>Members' phone numbers</span>
                <textarea name="participants" class="chip-input" placeholder="919876543210, 14155550123&#10;one per line or comma-separated, with country code"></textarea></label>
            ${!comm && state.communities.length ? `<label class="field"><span>Add to community (optional)</span>
                <select name="communityJid"><option value="">— none —</option>${state.communities.filter((c) => c.iAmAdmin).map((c) => `<option value="${esc(c.jid)}">${esc(c.subject)}</option>`).join('')}</select></label>` : ''}
            <div class="actions"><button class="btn btn-primary" id="btn-do-create">Create group</button></div>
        </form>`);
    action($('#btn-do-create', body), async () => {
        const f = new FormData($('#f-create', body));
        if (!f.get('subject')) throw new Error('Group name is required');
        await api('POST', '/groups', {
            subject: f.get('subject'), description: f.get('description'), participants: f.get('participants'),
            communityJid: communityJid || f.get('communityJid') || null
        });
        closeModal(); toast('Group created 🎉'); await loadGroups(); route();
    });
}

function bulkCreateModal() {
    const body = openModal('Bulk create groups', `
        <form class="form" id="f-bulk">
            <label class="field"><span>Group names</span><span class="hint">One per line. Groups are created one by one with a safe delay.</span>
                <textarea name="names" rows="6" placeholder="Batch A — Students&#10;Batch B — Students"></textarea></label>
            <label class="field"><span>Description (applied to all)</span><textarea name="description"></textarea></label>
            <label class="field"><span>Members to add to every group</span><textarea name="participants" class="chip-input" placeholder="919876543210, …"></textarea></label>
            ${state.communities.length ? `<label class="field"><span>Create inside community (optional)</span>
                <select name="communityJid"><option value="">— none —</option>${state.communities.filter((c) => c.iAmAdmin).map((c) => `<option value="${esc(c.jid)}">${esc(c.subject)}</option>`).join('')}</select></label>` : ''}
            <div class="actions"><button class="btn btn-primary" id="btn-do-bulk">Start</button></div>
            <div id="bulk-job"></div>
        </form>`);
    action($('#btn-do-bulk', body), async () => {
        const f = new FormData($('#f-bulk', body));
        const job = await api('POST', '/groups/bulk-create', {
            names: f.get('names'), description: f.get('description'), participants: f.get('participants'), communityJid: f.get('communityJid') || null
        });
        mountJob($('#bulk-job', body), job);
    });
}

function joinModal() {
    const body = openModal('Join a group via invite link', `
        <form class="form" id="f-join">
            <label class="field"><span>Invite link</span><input name="link" placeholder="https://chat.whatsapp.com/AbCdEf…" required></label>
            <div class="actions"><button class="btn btn-primary" id="btn-do-join">Join</button></div>
        </form>`);
    action($('#btn-do-join', body), async () => {
        await api('POST', '/groups/join', { link: new FormData($('#f-join', body)).get('link') });
        closeModal(); toast('Joined group'); await loadGroups(); route();
    });
}

async function openGroup(jid, tab = 'msg') {
    const body = openDrawer('Loading…', '<div class="skeleton"></div>');
    let g;
    try { g = await api('GET', `/groups/${encodeURIComponent(jid)}`); } catch (err) { body.innerHTML = empty('⚠️', 'Could not load group', err.message); return; }
    $('#drawer-title').textContent = g.subject;
    const tabs = [
        ['msg', '💬 Message'],
        ['members', `Members (${g.participants.length})`],
        ['add', 'Add members'],
        ['settings', 'Settings'],
        ['invite', 'Invite link']
    ];
    body.innerHTML = `
        <div class="meta-row" style="margin-bottom:14px">
            ${g.iAmAdmin ? '<span class="badge badge-ok">You are admin</span>' : '<span class="badge badge-amber">You are a member (admin needed for most actions)</span>'}
            <span class="badge">👑 ${g.admins} admins</span>
            ${g.isCommunity ? '<span class="badge badge-violet">Community</span>' : ''}
            ${g.creation ? `<span class="badge">Created ${esc(new Date(g.creation).toLocaleDateString())}</span>` : ''}
        </div>
        <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
        <div id="tab-body"></div>`;
    const show = (k) => {
        $$('.tabs button', body).forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
        ({ msg: tabMessage, members: tabMembers, add: tabAdd, settings: tabSettings, invite: tabInvite })[k]($('#tab-body', body), g);
    };
    $$('.tabs button', body).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(tab);
}

function tabMessage(el, g) {
    el.innerHTML = `
        <div style="margin-bottom:12px">
            <p class="muted" style="margin:0">Send a direct message to <b>${esc(g.subject)}</b> with dynamic group variables.</p>
        </div>
        ${renderMessageComposerHtml({ idPrefix: 'gtmsg', showPicker: false, showSchedule: false })}
        <div class="actions" style="margin-top:14px">
            <button class="btn btn-primary" id="btn-gtmsg-send">🚀 Send message now</button>
        </div>
    `;

    const { getCustomVars } = bindMessageComposer({
        root: el,
        idPrefix: 'gtmsg',
        getTargets: () => [g.jid]
    });

    action($('#btn-gtmsg-send', el), async () => {
        const text = $('#gtmsg-text', el).value;
        const file = $('#gtmsg-media', el).files[0];
        if (!text.trim() && !file) throw new Error('Write a message or attach a file');

        const fd = new FormData();
        fd.set('name', `Direct to ${g.subject}`);
        fd.set('text', text);
        fd.set('targets', JSON.stringify([g.jid]));
        fd.set('customVars', JSON.stringify(getCustomVars()));
        fd.set('mentionAll', $(`#gtmsg-mention`, el).checked);
        if (file) fd.set('media', file);

        await api('POST', '/broadcasts', fd, { form: true });
        toast(`Message queued for ${g.subject} 🚀`);
        $('#gtmsg-text', el).value = '';
    });
}

function tabMembers(el, g) {
    el.innerHTML = `
        <div class="toolbar" style="margin-bottom:12px">
            <input type="search" id="m-search" placeholder="Search members…">
            <a class="btn btn-sm" href="/api/groups/${encodeURIComponent(g.jid)}/export">⬇ Export CSV</a>
        </div>
        ${g.iAmAdmin ? `<div class="toolbar" style="margin-bottom:12px">
            <span class="hint" id="m-sel">0 selected</span>
            <button class="btn btn-sm" data-act="promote">👑 Make admin</button>
            <button class="btn btn-sm" data-act="demote">⬇ Remove admin</button>
            <button class="btn btn-sm btn-danger" data-act="remove">✕ Remove</button>
        </div>` : ''}
        <div id="m-job"></div>
        <div class="table-wrap"><table>
            <thead><tr>${g.iAmAdmin ? '<th style="width:30px"><input type="checkbox" id="m-all" style="width:auto"></th>' : ''}<th>Member</th><th>Phone</th><th>Role</th></tr></thead>
            <tbody id="m-rows"></tbody></table></div>`;
    const rows = $('#m-rows', el);
    const draw = () => {
        const q = $('#m-search', el).value.toLowerCase();
        rows.innerHTML = g.participants.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.phone || '').includes(q)).map((p) => `
            <tr>${g.iAmAdmin ? `<td>${p.isMe ? '' : `<input type="checkbox" value="${esc(p.jid)}" style="width:auto">`}</td>` : ''}
                <td><div style="display:flex;gap:10px;align-items:center">${avatar(p.name || p.phone || '?')}<span>${esc(p.name || '—')}${p.isMe ? ' <span class="badge">You</span>' : ''}</span></div></td>
                <td class="mono">${p.phone ? '+' + esc(p.phone) : '<span class="hint">hidden (LID)</span>'}</td>
                <td>${p.admin === 'superadmin' ? '<span class="badge badge-violet">Owner</span>' : p.admin ? '<span class="badge badge-ok">Admin</span>' : '<span class="hint">Member</span>'}</td></tr>`).join('');
    };
    $('#m-search', el).addEventListener('input', draw);
    draw();
    if (!g.iAmAdmin) return;
    const selected = () => $$('#m-rows input:checked', el).map((i) => i.value);
    el.addEventListener('change', (e) => {
        if (e.target.id === 'm-all') $$('#m-rows input[type=checkbox]', el).forEach((i) => { i.checked = e.target.checked; });
        $('#m-sel', el).textContent = `${selected().length} selected`;
    });
    $$('[data-act]', el).forEach((b) => action(b, async () => {
        const targets = selected();
        if (!targets.length) throw new Error('Select members first');
        if (b.dataset.act === 'remove' && !confirm(`Remove ${targets.length} member(s) from ${g.subject}?`)) return;
        const job = await api('POST', `/groups/${encodeURIComponent(g.jid)}/participants`, { action: b.dataset.act, targets });
        mountJob($('#m-job', el), job, () => openGroup(g.jid, 'members'));
    }));
}

function tabAdd(el, g) {
    if (!g.iAmAdmin) { el.innerHTML = empty('🔒', 'Admin required', 'You need to be an admin of this group to add members.'); return; }
    el.innerHTML = `<form class="form" id="f-add">
        <label class="field"><span>Phone numbers</span><span class="hint">With country code. One per line or comma-separated. Added in batches of 5 with safe delays.</span>
            <textarea name="targets" rows="8" class="chip-input" placeholder="919876543210&#10;+1 415 555 0123"></textarea></label>
        ${toggle('inv-fallback', 'Send invite link if privacy blocks adding', 'People who only allow contacts to add them get the group link by DM instead.', true)}
        <div class="actions"><button class="btn btn-primary" id="btn-do-add">Add members</button></div>
        <div id="add-job"></div></form>`;
    action($('#btn-do-add', el), async () => {
        const job = await api('POST', `/groups/${encodeURIComponent(g.jid)}/participants`, {
            action: 'add', targets: new FormData($('#f-add', el)).get('targets'), inviteFallback: $('#inv-fallback', el).checked
        });
        mountJob($('#add-job', el), job);
    });
}

function tabSettings(el, g) {
    const dis = g.iAmAdmin ? '' : 'disabled';
    el.innerHTML = `<form class="form" id="f-set">
        <label class="field"><span>Name</span><input name="subject" maxlength="100" value="${esc(g.subject)}" ${dis}></label>
        <label class="field"><span>Description</span><textarea name="desc" maxlength="2048" ${dis}>${esc(g.desc)}</textarea></label>
        ${toggle('s-announce', 'Only admins can send messages', 'Turns the group into an announcement channel.', g.announce)}
        ${toggle('s-restrict', 'Only admins can edit group info', '', g.restrict)}
        ${toggle('s-approval', 'Approve new members', 'Admins must approve join requests from invite links.', g.joinApprovalMode)}
        ${toggle('s-addmode', 'Members can add others', '', g.memberAddMode)}
        <div class="actions">
            <button class="btn btn-danger" id="btn-leave" type="button">Leave ${g.isCommunity ? 'community' : 'group'}</button>
            ${g.iAmAdmin ? '<button class="btn btn-primary" id="btn-save-set">Save changes</button>' : ''}
        </div></form>`;
    if (!g.iAmAdmin) $$('input[type=checkbox]', el).forEach((i) => { i.disabled = true; });
    const save = $('#btn-save-set', el);
    if (save) action(save, async () => {
        const f = new FormData($('#f-set', el));
        const patch = {};
        if (f.get('subject') !== g.subject) patch.subject = f.get('subject');
        if (f.get('desc') !== g.desc) patch.desc = f.get('desc');
        const map = { 's-announce': 'announce', 's-restrict': 'restrict', 's-approval': 'joinApprovalMode', 's-addmode': 'memberAddMode' };
        for (const [id, k] of Object.entries(map)) if ($(`#${id}`, el).checked !== g[k]) patch[k] = $(`#${id}`, el).checked;
        if (!Object.keys(patch).length) return toast('Nothing changed');
        await api('PATCH', `/groups/${encodeURIComponent(g.jid)}`, patch);
        toast('Settings saved'); Object.assign(g, patch); $('#drawer-title').textContent = g.subject;
    });
    action($('#btn-leave', el), async () => {
        if (!confirm(`Leave "${g.subject}"? You will stop receiving its messages.`)) return;
        await api('POST', `/groups/${encodeURIComponent(g.jid)}/leave`);
        closeDrawer(); toast('Left group'); await loadGroups(); route();
    });
}

function tabInvite(el, g) {
    if (!g.iAmAdmin) { el.innerHTML = empty('🔒', 'Admin required', 'Only admins can see or reset the invite link.'); return; }
    el.innerHTML = `<div class="form">
        <label class="field"><span>Invite link</span><input id="inv-link" readonly placeholder="Click “Get link”"></label>
        <div class="actions">
            <button class="btn btn-danger" id="btn-revoke">Reset link</button>
            <button class="btn" id="btn-copy">Copy</button>
            <button class="btn btn-primary" id="btn-get">Get link</button>
        </div></div>`;
    const set = (l) => { $('#inv-link', el).value = l || ''; };
    action($('#btn-get', el), async () => set((await api('GET', `/groups/${encodeURIComponent(g.jid)}/invite`)).link));
    action($('#btn-revoke', el), async () => {
        if (!confirm('Reset the link? The old link will stop working.')) return;
        set((await api('POST', `/groups/${encodeURIComponent(g.jid)}/invite/revoke`)).link); toast('Invite link reset');
    });
    action($('#btn-copy', el), async () => {
        const v = $('#inv-link', el).value; if (!v) throw new Error('Get the link first');
        await navigator.clipboard.writeText(v); toast('Copied');
    });
}

// ---------- jobs ----------

function mountJob(el, job, onDone) {
    el.dataset.job = job.id;
    el.onJobDone = onDone;
    jobs.set(job.id, job);
    renderJob(el, jobs.get(job.id));
}

function renderJob(el, job) {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    const ok = job.results.filter((r) => r.ok).length;
    el.innerHTML = `<div class="card glass" style="margin-top:12px">
        <div class="card-head"><h2>${job.status === 'running' ? '⏳ Working…' : job.status === 'done' ? '✅ Finished' : '⚠️ Failed'}</h2>
            <span class="hint">${job.done}/${job.total} · ${ok} ok · ${job.done - ok} failed</span></div>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="result-list" style="margin-top:12px">${job.results.slice().reverse().map((r) => `
            <div><span class="mono">${esc(r.target)}</span><span class="${r.ok ? '' : 'error-text'}">${r.ok ? '✓' : '✕'} ${esc(r.info || '')}</span></div>`).join('')}</div>
    </div>`;
    if (job.status !== 'running' && el.onJobDone) { const f = el.onJobDone; el.onJobDone = null; setTimeout(f, 1500); }
}

// ====================================================================
// communities
// ====================================================================

async function renderCommunities() {
    const blocked = requireConnected();
    if (blocked) { page.innerHTML = blocked; return; }
    actions.innerHTML = '<button id="btn-new-comm" class="btn btn-primary">＋ New community</button>';
    action($('#btn-new-comm'), () => {
        const body = openModal('Create a community', `<form class="form" id="f-comm">
            <label class="field"><span>Community name</span><input name="subject" maxlength="100" required></label>
            <label class="field"><span>Description</span><textarea name="description" maxlength="2048"></textarea></label>
            <p class="hint">WhatsApp automatically creates an <b>Announcements</b> group for every community.</p>
            <div class="actions"><button class="btn btn-primary" id="btn-do-comm">Create community</button></div></form>`);
        action($('#btn-do-comm', body), async () => {
            const f = new FormData($('#f-comm', body));
            if (!f.get('subject')) throw new Error('Name is required');
            await api('POST', '/communities', { subject: f.get('subject'), description: f.get('description') });
            closeModal(); toast('Community created 🎉'); await loadGroups(); route();
        });
    });

    if (!state.communities.length) {
        page.innerHTML = `<div class="card glass">${empty('🏘️', 'No communities yet', 'Create a community to organise related groups under one roof with a shared announcements channel.')}</div>`;
        return;
    }
    page.innerHTML = state.communities.map((c) => `
        <section class="community glass" data-comm="${esc(c.jid)}">
            <div class="community-head">
                <h3>${avatar(c.subject)}<span>${esc(c.subject)}<br><span class="hint">${fmtNum(c.subgroups.length)} groups · ${fmtNum(c.subgroups.reduce((s, g) => s + g.size, 0))} members</span></span></h3>
                <div class="toolbar">
                    ${c.iAmAdmin ? `<button class="btn btn-sm" data-a="invite">🔗 Invite link</button>
                    <button class="btn btn-sm" data-a="link">⛓ Link existing group</button>
                    <button class="btn btn-sm btn-primary" data-a="new">＋ New group</button>` : '<span class="badge">Member</span>'}
                    <button class="btn btn-sm btn-ghost" data-a="settings">⚙</button>
                </div>
            </div>
            ${c.desc ? `<p class="hint" style="margin:0">${esc(c.desc)}</p>` : ''}
            <div class="subgroups">${c.subgroups.map((g) => `
                <div class="subgroup" data-jid="${esc(g.jid)}">
                    <b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${g.isCommunityAnnounce ? '📢 ' : ''}${esc(g.subject)}</b>
                    <div class="meta-row"><span class="badge">👤 ${fmtNum(g.size)}</span>${g.iAmAdmin ? '<span class="badge badge-ok">Admin</span>' : ''}
                    ${c.iAmAdmin && !g.isCommunityAnnounce ? `<button class="btn btn-sm btn-ghost" data-unlink="${esc(g.jid)}" title="Unlink from community">Unlink</button>` : ''}</div>
                </div>`).join('') || '<p class="hint">No groups linked yet.</p>'}</div>
        </section>`).join('');

    $$('[data-comm]').forEach((sec) => {
        const c = state.communities.find((x) => x.jid === sec.dataset.comm);
        $$('.subgroup', sec).forEach((s) => s.addEventListener('click', (e) => { if (!e.target.dataset.unlink) openGroup(s.dataset.jid); }));
        $$('[data-unlink]', sec).forEach((b) => action(b, async (e) => {
            e.stopPropagation();
            if (!confirm('Unlink this group from the community?')) return;
            await api('POST', `/communities/${encodeURIComponent(c.jid)}/link`, { groupJid: b.dataset.unlink, unlink: true });
            toast('Group unlinked'); await loadGroups(); route();
        }));
        $$('[data-a]', sec).forEach((b) => action(b, async () => {
            const a = b.dataset.a;
            if (a === 'new') return createGroupModal(c.jid);
            if (a === 'settings') return openGroup(c.jid, 'settings');
            if (a === 'invite') {
                const { link } = await api('GET', `/groups/${encodeURIComponent(c.jid)}/invite`);
                openModal(`Invite to ${c.subject}`, `<div class="form"><input readonly value="${esc(link || '')}" id="ci-link">
                    <div class="actions"><button class="btn btn-primary" id="ci-copy">Copy link</button></div></div>`);
                action($('#ci-copy'), async () => { await navigator.clipboard.writeText($('#ci-link').value); toast('Copied'); });
            }
            if (a === 'link') {
                const free = state.groups.filter((g) => !g.linkedParent && g.iAmAdmin);
                const body = openModal(`Link a group to ${c.subject}`, free.length ? `<div class="form">
                    <label class="field"><span>Group</span><select id="lk-group">${free.map((g) => `<option value="${esc(g.jid)}">${esc(g.subject)}</option>`).join('')}</select></label>
                    <div class="actions"><button class="btn btn-primary" id="lk-do">Link group</button></div></div>`
                    : empty('🤷', 'No eligible groups', 'You need to be admin of a group that is not already in a community.'));
                const go = $('#lk-do', body);
                if (go) action(go, async () => {
                    await api('POST', `/communities/${encodeURIComponent(c.jid)}/link`, { groupJid: $('#lk-group', body).value });
                    closeModal(); toast('Group linked'); await loadGroups(); route();
                });
            }
        }));
    });
}

// ====================================================================
// broadcasts
// ====================================================================

const STATUS_BADGE = { scheduled: 'badge-amber', running: 'badge-ok', done: 'badge-ok', failed: 'badge-danger', cancelled: '' };

async function renderBroadcasts() {
    const list = await api('GET', '/broadcasts');
    const blocked = state.status.status !== 'connected'
        ? '<p class="hint">⚠️ WhatsApp is not connected — broadcasts will wait and send once you reconnect.</p>' : '';
    page.innerHTML = `
        <div class="card glass">
            <div class="card-head">
                <h2>📣 New broadcast / group message</h2>
                <span class="hint">Sent group by group with random human-like delay to protect your number</span>
            </div>
            ${blocked}
            ${renderMessageComposerHtml({ idPrefix: 'bc', showPicker: true, showSchedule: true })}
            <div class="actions" style="margin-top:16px">
                <button class="btn btn-primary" id="btn-send-bc">🚀 Send / Schedule broadcast</button>
            </div>
        </div>
        <div class="card glass"><div class="card-head"><h2>History</h2></div><div id="bc-list"></div></div>`;

    const picker = groupPicker($('#bc-picker'), []);
    const { getCustomVars, updatePreview } = bindMessageComposer({
        root: page,
        idPrefix: 'bc',
        getTargets: () => picker.get()
    });

    $('#bc-picker').addEventListener('change', updatePreview);

    action($('#btn-send-bc'), async () => {
        const fd = new FormData();
        const targets = picker.get();
        if (!targets.length) throw new Error('Pick at least one target group');
        const text = $('#bc-text').value;
        const file = $('#bc-media').files[0];
        if (!text.trim() && !file) throw new Error('Write a message or attach a file');

        const name = $('input[name=name]', page)?.value || `Broadcast to ${targets.length} groups`;
        const scheduleAt = $('input[name=scheduleAt]', page)?.value;
        const at = scheduleAt ? new Date(scheduleAt).toISOString() : null;
        const repeat = $('select[name=repeat]', page)?.value || 'none';

        fd.set('name', name);
        fd.set('text', text);
        fd.set('targets', JSON.stringify(targets));
        fd.set('customVars', JSON.stringify(getCustomVars()));
        fd.set('mentionAll', $('#bc-mention').checked);
        fd.set('repeat', repeat);
        if (at) fd.set('scheduleAt', at);
        if (file) fd.set('media', file);

        await api('POST', '/broadcasts', fd, { form: true });
        toast(at ? 'Broadcast scheduled 🗓️' : 'Broadcast started 🚀');
        renderBroadcasts();
    });
    drawBroadcastList(list);
}

function drawBroadcastList(list) {
    const el = $('#bc-list');
    el.innerHTML = list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th>Schedule</th><th></th></tr></thead>
        <tbody>${list.map(bcRow).join('')}</tbody></table></div>` : empty('📭', 'No broadcasts yet', 'Your scheduled and sent broadcasts will show up here.');
    bindBroadcastRows();
}

function bcRow(b) {
    const p = b.progress || { total: b.targets.length, sent: 0, failed: 0 };
    const pct = p.total ? Math.round(((p.sent + p.failed) / p.total) * 100) : 0;
    return `<tr data-bc="${esc(b.id)}">
        <td><b>${esc(b.name)}</b><br><span class="hint">${b.media ? '📎 ' : ''}${esc((b.text || '').slice(0, 60))}${(b.text || '').length > 60 ? '…' : ''}</span></td>
        <td><span class="badge ${STATUS_BADGE[b.status] || ''}">${esc(b.status)}</span>${b.repeat !== 'none' ? ` <span class="badge badge-violet">↻ ${esc(b.repeat)}</span>` : ''}</td>
        <td style="min-width:160px"><div class="progress ${p.failed && !p.sent ? 'danger' : ''}"><div style="width:${pct}%"></div></div>
            <span class="hint">${p.sent} sent · ${p.failed} failed · ${p.total} groups</span></td>
        <td class="hint">${b.status === 'scheduled' ? 'Next: ' + esc(fmtDate(b.nextRunAt)) : b.lastRunAt ? 'Ran ' + esc(ago(b.lastRunAt)) : '—'}</td>
        <td style="white-space:nowrap">
            <button class="btn btn-sm btn-ghost" data-bca="log">Log</button>
            ${['scheduled', 'running'].includes(b.status) ? '<button class="btn btn-sm" data-bca="cancel">Cancel</button>' : '<button class="btn btn-sm" data-bca="run">Run again</button>'}
            ${b.status !== 'running' ? '<button class="btn btn-sm btn-danger" data-bca="delete">✕</button>' : ''}
        </td></tr>`;
}

const bcCache = new Map();
function bindBroadcastRows() {
    $$('#bc-list [data-bca]').forEach((btn) => action(btn, async () => {
        const id = btn.closest('tr').dataset.bc;
        const a = btn.dataset.bca;
        if (a === 'log') {
            const b = bcCache.get(id) || (await api('GET', '/broadcasts')).find((x) => x.id === id);
            openModal(`Log · ${b.name}`, b.log?.length ? `<div class="result-list">${b.log.slice().reverse().map((l) => `
                <div><span>${esc(l.subject)}</span><span class="${l.ok ? '' : 'error-text'}">${l.ok ? '✓ sent' : '✕ ' + esc(l.error)} · ${esc(ago(l.at))}</span></div>`).join('')}</div>`
                : empty('🕐', 'Nothing sent yet', ''));
            return;
        }
        if (a === 'delete' && !confirm('Delete this broadcast?')) return;
        if (a === 'cancel') await api('POST', `/broadcasts/${id}/cancel`);
        if (a === 'run') await api('POST', `/broadcasts/${id}/run-now`);
        if (a === 'delete') await api('DELETE', `/broadcasts/${id}`);
        drawBroadcastList(await api('GET', '/broadcasts'));
    }));
}

function updateBroadcastRow(b) {
    bcCache.set(b.id, b);
    const row = $(`#bc-list tr[data-bc="${CSS.escape(b.id)}"]`);
    if (!row) return;
    row.outerHTML = bcRow(b);
    bindBroadcastRows();
}

// ====================================================================
// auto-replies
// ====================================================================

async function renderAutoReplies() {
    const rules = await api('GET', '/auto-replies');
    actions.innerHTML = '<button id="btn-new-rule" class="btn btn-primary">＋ New rule</button>';
    action($('#btn-new-rule'), () => ruleModal());
    page.innerHTML = `
        <p class="muted" style="margin:0">Reply automatically when a group message matches a keyword. The first matching rule wins. Use <span class="mono">@user</span> to mention the sender, <span class="mono">{name}</span> and <span class="mono">{group}</span> as placeholders.</p>
        ${rules.length ? rules.map((r) => `
            <div class="rule glass" data-rule="${esc(r.id)}">
                <div>
                    <div class="meta-row"><b>${esc(r.name || 'Untitled rule')}</b>
                        <span class="badge">${esc(r.matchType)}</span><span class="trigger">${esc(r.trigger)}</span>
                        <span class="badge">${r.groups.length ? `${r.groups.length} groups` : 'All groups'}</span>
                        <span class="badge">⏱ ${r.cooldownSec}s</span><span class="badge badge-ok">${fmtNum(r.hits)} replies</span></div>
                    <p>${esc(r.response)}</p>
                </div>
                <div class="toolbar">
                    <label class="toggle" style="padding:6px 10px"><input type="checkbox" data-en ${r.enabled ? 'checked' : ''}><span class="switch"></span></label>
                    <button class="btn btn-sm" data-edit>Edit</button><button class="btn btn-sm btn-danger" data-del>✕</button>
                </div>
            </div>`).join('') : `<div class="card glass">${empty('🤖', 'No auto-replies yet', 'Create a rule like “price” → “Our plans start at ₹499. DM us!”')}</div>`}`;
    $$('[data-rule]').forEach((el) => {
        const r = rules.find((x) => x.id === el.dataset.rule);
        $('[data-en]', el).addEventListener('change', async (e) => {
            try { await api('PUT', `/auto-replies/${r.id}`, { enabled: e.target.checked }); toast(e.target.checked ? 'Rule enabled' : 'Rule paused'); } catch (err) { toast(err.message, 'error'); }
        });
        $('[data-edit]', el).addEventListener('click', () => ruleModal(r));
        action($('[data-del]', el), async () => { if (confirm('Delete this rule?')) { await api('DELETE', `/auto-replies/${r.id}`); renderAutoReplies(); } });
    });
}

function ruleModal(r = null) {
    const body = openModal(r ? 'Edit auto-reply' : 'New auto-reply', `<form class="form" id="f-rule">
        <label class="field"><span>Rule name</span><input name="name" value="${esc(r?.name || '')}" placeholder="Pricing question"></label>
        <div class="row">
            <label class="field"><span>When a message…</span><select name="matchType">
                ${[['contains', 'contains'], ['exact', 'is exactly'], ['startsWith', 'starts with'], ['regex', 'matches regex']].map(([v, l]) => `<option value="${v}" ${r?.matchType === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
            <label class="field"><span>Keyword / pattern</span><input name="trigger" required value="${esc(r?.trigger || '')}" placeholder="price"></label>
        </div>
        <label class="field"><span>Reply with</span><textarea name="response" required rows="4">${esc(r?.response || 'Hi @user 👋 ')}</textarea></label>
        <div class="row">
            <label class="field"><span>Cooldown per group (seconds)</span><input name="cooldownSec" type="number" min="0" value="${r?.cooldownSec ?? 30}"></label>
        </div>
        ${toggle('r-quote', 'Reply as a quote', 'Quotes the triggering message.', r?.quote ?? true)}
        ${toggle('r-case', 'Case sensitive', '', r?.caseSensitive ?? false)}
        <label class="field"><span>Active in</span><div id="r-picker"></div></label>
        <div class="actions"><button class="btn btn-primary" id="btn-save-rule">${r ? 'Save rule' : 'Create rule'}</button></div></form>`);
    const picker = groupPicker($('#r-picker', body), r?.groups || [], { allLabel: 'All groups' });
    action($('#btn-save-rule', body), async () => {
        const f = new FormData($('#f-rule', body));
        const payload = {
            name: f.get('name'), matchType: f.get('matchType'), trigger: f.get('trigger'), response: f.get('response'),
            cooldownSec: f.get('cooldownSec'), quote: $('#r-quote', body).checked, caseSensitive: $('#r-case', body).checked, groups: picker.get()
        };
        if (!payload.trigger || !payload.response) throw new Error('Keyword and reply are required');
        if (r) await api('PUT', `/auto-replies/${r.id}`, payload); else await api('POST', '/auto-replies', payload);
        closeModal(); toast('Rule saved'); renderAutoReplies();
    });
}

// ====================================================================
// moderation
// ====================================================================

async function renderModeration() {
    const m = await api('GET', '/moderation');
    page.innerHTML = `<div class="card glass"><form class="form" id="f-mod">
        ${toggle('mod-enabled', 'Moderation enabled', 'Works only in groups where your number is an admin.', m.enabled)}
        <div class="grid-2">
            <div class="form">
                <div class="section-title">Rules</div>
                ${toggle('mod-link', 'Anti-link', 'Delete messages containing links / group invites.', m.antiLink)}
                <label class="field"><span>Allowed domains</span><span class="hint">Comma or newline separated, e.g. youtube.com, mysite.in</span>
                    <textarea name="allowedDomains" rows="2">${esc(m.allowedDomains.join(', '))}</textarea></label>
                ${toggle('mod-spam', 'Anti-spam / flood', 'Too many messages in a short time.', m.antiSpam)}
                <div class="row">
                    <label class="field"><span>Max messages</span><input name="spamMaxMessages" type="number" min="2" value="${m.spamMaxMessages}"></label>
                    <label class="field"><span>Within (seconds)</span><input name="spamWindowSec" type="number" min="2" value="${m.spamWindowSec}"></label>
                </div>
                <label class="field"><span>Banned words</span><span class="hint">Comma or newline separated. Matches whole words, any language.</span>
                    <textarea name="bannedWords" rows="3">${esc(m.bannedWords.join(', '))}</textarea></label>
            </div>
            <div class="form">
                <div class="section-title">Action</div>
                <label class="field"><span>When a rule is broken</span><select name="action">
                    <option value="delete" ${m.action === 'delete' ? 'selected' : ''}>Delete message</option>
                    <option value="warn" ${m.action === 'warn' ? 'selected' : ''}>Delete + warn, remove after N warnings</option>
                    <option value="remove" ${m.action === 'remove' ? 'selected' : ''}>Delete + remove member immediately</option>
                </select></label>
                <label class="field"><span>Warnings before removal</span><input name="maxWarnings" type="number" min="1" value="${m.maxWarnings}"></label>
                <label class="field"><span>Warning message</span><span class="hint">@user, {reason}, {count}, {max}, {group}</span>
                    <textarea name="warnText" rows="3">${esc(m.warnText)}</textarea></label>
                ${toggle('mod-exempt', 'Exempt admins', 'Admins are never moderated.', m.exemptAdmins)}
                <p class="hint">${fmtNum(m.activeWarnings)} members currently have warnings.
                    ${m.activeWarnings ? '<label class="picker-item" style="display:inline-flex"><input type="checkbox" id="mod-reset"> reset all</label>' : ''}</p>
            </div>
        </div>
        <label class="field"><span>Apply to</span><div id="mod-picker"></div></label>
        <div class="actions"><button class="btn btn-primary" id="btn-save-mod">Save moderation</button></div>
    </form></div>`;
    const picker = groupPicker($('#mod-picker'), m.groups, { allLabel: 'All groups where I am admin', adminOnly: true });
    action($('#btn-save-mod'), async () => {
        const f = new FormData($('#f-mod'));
        await api('PUT', '/moderation', {
            ...Object.fromEntries(f), enabled: $('#mod-enabled').checked, antiLink: $('#mod-link').checked,
            antiSpam: $('#mod-spam').checked, exemptAdmins: $('#mod-exempt').checked, groups: picker.get(),
            resetWarnings: !!$('#mod-reset')?.checked
        });
        toast('Moderation saved 🛡️');
    });
}

// ====================================================================
// welcome
// ====================================================================

async function renderWelcome() {
    const w = await api('GET', '/welcome');
    page.innerHTML = `<div class="card glass"><form class="form" id="f-w">
        <div class="grid-2">
            <div class="form">
                ${toggle('w-enabled', 'Welcome new members', 'Sent when someone joins or is added.', w.enabled)}
                <label class="field"><span>Welcome message</span><span class="hint">@user mentions the new member(s) · {group} · {count}</span>
                    <textarea name="welcomeText" rows="5">${esc(w.welcomeText)}</textarea></label>
            </div>
            <div class="form">
                ${toggle('w-bye', 'Say goodbye', 'Sent when someone leaves or is removed.', w.goodbyeEnabled)}
                <label class="field"><span>Goodbye message</span><span class="hint">@user · {group}</span>
                    <textarea name="goodbyeText" rows="5">${esc(w.goodbyeText)}</textarea></label>
            </div>
        </div>
        <label class="field"><span>Active in</span><div id="w-picker"></div></label>
        <div class="actions"><button class="btn btn-primary" id="btn-save-w">Save</button></div>
    </form></div>`;
    const picker = groupPicker($('#w-picker'), w.groups, { allLabel: 'All groups' });
    action($('#btn-save-w'), async () => {
        const f = new FormData($('#f-w'));
        await api('PUT', '/welcome', {
            welcomeText: f.get('welcomeText'), goodbyeText: f.get('goodbyeText'),
            enabled: $('#w-enabled').checked, goodbyeEnabled: $('#w-bye').checked, groups: picker.get()
        });
        toast('Welcome settings saved 👋');
    });
}

// ====================================================================
// leads
// ====================================================================

const leadQuery = { q: '', group: '', page: 1 };

async function renderLeads() {
    const lc = await api('GET', '/lead-capture');
    actions.innerHTML = `<a id="btn-lead-export" class="btn btn-primary" href="#">⬇ Export CSV</a>`;
    $('#btn-lead-export').addEventListener('click', (e) => {
        e.preventDefault();
        location.href = `/api/leads/export${leadQuery.group ? `?group=${encodeURIComponent(leadQuery.group)}` : ''}`;
    });
    page.innerHTML = `
        <div class="card glass">${toggle('lead-enabled', 'Automatic lead capture', 'Every group member and message sender is saved as a contact (phone, name, groups, activity).', lc.enabled)}</div>
        <div class="card glass">
            <div class="toolbar" style="margin-bottom:14px">
                <input type="search" id="lead-q" placeholder="Search name or phone…" value="${esc(leadQuery.q)}">
                <select id="lead-group" style="max-width:280px"><option value="">All groups</option>
                    ${allTargets().map((g) => `<option value="${esc(g.jid)}" ${leadQuery.group === g.jid ? 'selected' : ''}>${esc(g.subject)}</option>`).join('')}</select>
                <span class="hint" id="lead-total"></span>
                <button class="btn btn-sm btn-danger" id="lead-clear" style="margin-left:auto">Clear all</button>
            </div>
            <div id="lead-table"></div>
        </div>`;
    $('#lead-enabled').addEventListener('change', async (e) => {
        try { await api('PUT', '/lead-capture', { enabled: e.target.checked }); toast(e.target.checked ? 'Lead capture on' : 'Lead capture off'); drawLeads(); } catch (err) { toast(err.message, 'error'); }
    });
    let t;
    $('#lead-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { leadQuery.q = e.target.value; leadQuery.page = 1; drawLeads(); }, 250); });
    $('#lead-group').addEventListener('change', (e) => { leadQuery.group = e.target.value; leadQuery.page = 1; drawLeads(); });
    action($('#lead-clear'), async () => { if (confirm('Delete ALL captured leads?')) { await api('DELETE', '/leads'); drawLeads(); } });
    drawLeads();
}

async function drawLeads() {
    const qs = new URLSearchParams({ q: leadQuery.q, group: leadQuery.group, page: leadQuery.page });
    const d = await api('GET', `/leads?${qs}`);
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    $('#lead-total').textContent = `${fmtNum(d.total)} leads`;
    $('#lead-table').innerHTML = d.rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Contact</th><th>Phone</th><th>Groups</th><th>Messages</th><th>Last seen</th></tr></thead>
        <tbody>${d.rows.map((l) => {
            const gs = Object.values(l.groups).filter(Boolean);
            return `<tr><td><div style="display:flex;gap:10px;align-items:center">${avatar(l.name || l.phone || '?')}${esc(l.name || '—')}</div></td>
                <td class="mono">${l.phone ? '+' + esc(l.phone) : '<span class="hint">hidden</span>'}</td>
                <td><span title="${esc(gs.join('\n'))}">${esc(gs.slice(0, 2).join(', '))}${gs.length > 2 ? ` <span class="badge">+${gs.length - 2}</span>` : ''}</span></td>
                <td>${fmtNum(l.messages)}</td><td class="hint">${esc(ago(l.lastSeen))}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="actions" style="margin-top:12px;align-items:center">
            <button class="btn btn-sm" id="lp-prev" ${leadQuery.page <= 1 ? 'disabled' : ''}>← Prev</button>
            <span class="hint">Page ${leadQuery.page} / ${pages}</span>
            <button class="btn btn-sm" id="lp-next" ${leadQuery.page >= pages ? 'disabled' : ''}>Next →</button>
        </div>` : empty('📇', 'No leads yet', 'Leads appear automatically as members are synced and people message in your groups.');
    $('#lp-prev')?.addEventListener('click', () => { leadQuery.page--; drawLeads(); });
    $('#lp-next')?.addEventListener('click', () => { leadQuery.page++; drawLeads(); });
}

// ====================================================================
// analytics
// ====================================================================

const anQuery = { jid: '', days: 30 };

async function renderAnalytics() {
    const qs = new URLSearchParams({ days: anQuery.days, ...(anQuery.jid ? { jid: anQuery.jid } : {}) });
    const a = await api('GET', `/analytics?${qs}`);
    actions.innerHTML = `
        <select id="an-group" style="max-width:260px"><option value="">All groups</option>
            ${allTargets().map((g) => `<option value="${esc(g.jid)}" ${anQuery.jid === g.jid ? 'selected' : ''}>${esc(g.subject)}</option>`).join('')}</select>
        <select id="an-days" style="width:auto">${[7, 14, 30, 60, 90].map((d) => `<option value="${d}" ${anQuery.days === d ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select>`;
    $('#an-group').addEventListener('change', (e) => { anQuery.jid = e.target.value; renderAnalytics(); });
    $('#an-days').addEventListener('change', (e) => { anQuery.days = Number(e.target.value); renderAnalytics(); });
    const net = a.totals.joins - a.totals.leaves;
    const lastSize = [...a.series].reverse().find((d) => d.size)?.size || 0;
    page.innerHTML = `
        <div class="stats">
            ${stat('💬', 'Messages', fmtNum(a.totals.messages), 'var(--accent)')}
            ${stat('➕', 'Joined', fmtNum(a.totals.joins), 'var(--accent-2)')}
            ${stat('➖', 'Left', fmtNum(a.totals.leaves), 'var(--danger)')}
            ${stat('📈', 'Net growth', (net >= 0 ? '+' : '') + fmtNum(net), 'var(--violet)')}
            ${stat('👥', 'Members (tracked)', fmtNum(lastSize), 'var(--amber)')}
        </div>
        <div class="card glass"><div class="card-head"><h2>Activity</h2></div>
            ${lineChart(a.series, [{ key: 'messages', label: 'Messages', color: 'hsl(152 68% 47%)', fill: true }])}</div>
        <div class="grid-2">
            <div class="card glass"><div class="card-head"><h2>Joins vs leaves</h2></div>
                ${lineChart(a.series, [{ key: 'joins', label: 'Joined', color: 'hsl(174 72% 42%)', fill: true }, { key: 'leaves', label: 'Left', color: 'hsl(355 80% 62%)' }], { height: 200 })}</div>
            <div class="card glass"><div class="card-head"><h2>Member growth</h2></div>
                ${lineChart(a.series, [{ key: 'size', label: 'Members', color: 'hsl(258 85% 70%)', fill: true }], { height: 200 })}</div>
        </div>
        <div class="grid-2">
            <div class="card glass"><div class="card-head"><h2>🏆 Top members</h2></div>
                ${barList(a.topMembers, { label: (m) => m.name || (m.phone ? '+' + m.phone : 'Member'), sub: (m) => (m.name && m.phone ? '+' + m.phone : ''), value: (m) => m.count })}</div>
            <div class="card glass"><div class="card-head"><h2>🔥 Most active groups</h2></div>
                ${barList(a.topGroups.filter((g) => g.messages), { label: (g) => g.subject, sub: (g) => `${fmtNum(g.size)} members`, value: (g) => g.messages })}</div>
        </div>
        <p class="hint">Analytics are collected from the moment the app is connected; history before that is not available from WhatsApp.</p>`;
}

boot();
