import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { wa } from '../wa/session.js';
import * as manage from '../wa/manage.js';
import { leadsCsv, toCsv, captureAll } from '../automation/leads.js';
import { summary } from '../automation/analytics.js';
import { publicView, kick, isRunning } from '../automation/broadcast.js';
import { jidToPhone } from '../wa/util.js';
import { chatService } from '../chat/chat.service.js';

export const AUTH_COOKIE = 'wag_auth';
export const authToken = () => crypto.createHash('sha256').update(`wa-groups:${config.adminPassword}`).digest('hex');

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const str = (v, max = 4096) => (v == null ? '' : String(v)).slice(0, max);
const jidList = (v) => (Array.isArray(v) ? v : []).map(String).filter((j) => j.endsWith('@g.us'));
const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1;

fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: config.uploadDir,
        filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).slice(0, 10)}`)
    }),
    limits: { fileSize: 64 * 1024 * 1024 }
});

const r = express.Router();

// ---------- auth ----------

r.post('/login', (req, res) => {
    const ok = typeof req.body?.password === 'string' &&
        crypto.timingSafeEqual(
            crypto.createHash('sha256').update(req.body.password).digest(),
            crypto.createHash('sha256').update(config.adminPassword).digest()
        );
    if (!ok) throw bad('Wrong password', 401);
    res.cookie(AUTH_COOKIE, authToken(), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400000 });
    res.json({ ok: true });
});

r.use((req, res, next) => {
    if (req.cookies?.[AUTH_COOKIE] !== authToken()) throw bad('Not logged in', 401);
    next();
});

r.post('/logout', (req, res) => { res.clearCookie(AUTH_COOKIE); res.json({ ok: true }); });

// ---------- connection ----------

r.get('/status', (req, res) => res.json(wa.publicState()));
r.post('/wa/connect', async (req, res) => { await wa.connect({ force: bool(req.body?.force) }); res.json(wa.publicState()); });
r.post('/wa/logout', async (req, res) => { await wa.logout(); res.json(wa.publicState()); });
r.post('/wa/refresh', async (req, res) => { await wa.refreshGroups(); res.json(manage.listAll()); });

// ---------- live chats ----------

r.get('/chats', (req, res) => res.json(chatService.getChatsList()));
r.get('/chats/:jid/messages', (req, res) => res.json(chatService.getChatMessages(req.params.jid)));
r.post('/chats/:jid/read', (req, res) => { chatService.markRead(req.params.jid); res.json({ ok: true }); });
r.post('/chats/:jid/messages', upload.single('media'), async (req, res) => {
    let customVars = {};
    try {
        if (typeof req.body?.customVars === 'string') customVars = JSON.parse(req.body.customVars);
        else if (req.body?.customVars && typeof req.body.customVars === 'object') customVars = req.body.customVars;
    } catch { customVars = {}; }

    const result = await chatService.sendChatMessage(req.params.jid, {
        text: str(req.body?.text, 4096),
        file: req.file,
        customVars
    });
    res.json(result);
});

// ---------- groups & communities ----------

r.get('/groups', (req, res) => res.json(manage.listAll()));
r.post('/groups', async (req, res) => res.json(await manage.createGroup({
    subject: str(req.body.subject, 100), description: str(req.body.description, 2048),
    participants: req.body.participants, communityJid: req.body.communityJid || null
})));
r.post('/groups/bulk-create', (req, res) => res.json(manage.bulkCreateGroups({
    names: str(req.body.names, 20000), description: str(req.body.description, 2048),
    participants: req.body.participants, communityJid: req.body.communityJid || null
})));
r.post('/groups/join', async (req, res) => res.json({ jid: await manage.joinByInvite(str(req.body.link, 200)) }));

r.get('/groups/:jid', async (req, res) => res.json(await manage.groupDetail(req.params.jid)));
r.patch('/groups/:jid', async (req, res) => {
    const b = {};
    for (const k of ['subject', 'desc']) if (req.body[k] !== undefined) b[k] = str(req.body[k], k === 'subject' ? 100 : 2048);
    for (const k of ['announce', 'restrict', 'joinApprovalMode', 'memberAddMode']) if (req.body[k] !== undefined) b[k] = bool(req.body[k]);
    res.json(await manage.updateGroup(req.params.jid, b));
});
r.post('/groups/:jid/participants', (req, res) => res.json(manage.bulkParticipants(req.params.jid, {
    action: req.body.action, targets: req.body.targets, inviteFallback: bool(req.body.inviteFallback)
})));
r.get('/groups/:jid/invite', async (req, res) => res.json({ link: await manage.inviteLink(req.params.jid) }));
r.post('/groups/:jid/invite/revoke', async (req, res) => res.json({ link: await manage.inviteLink(req.params.jid, { revoke: true }) }));
r.post('/groups/:jid/leave', async (req, res) => { await manage.leave(req.params.jid); res.json({ ok: true }); });
r.get('/groups/:jid/export', async (req, res) => {
    const g = await manage.groupDetail(req.params.jid);
    const csv = toCsv(g.participants, [
        { label: 'Name', get: (p) => p.name },
        { label: 'Phone', get: (p) => (p.phone ? `+${p.phone}` : '') },
        { label: 'WhatsApp ID', get: (p) => p.jid },
        { label: 'Role', get: (p) => p.admin || 'member' }
    ]);
    const safe = g.subject.replace(/[^\w\- ]+/g, '').trim() || 'group';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-members.csv"`);
    res.send(csv);
});

r.post('/communities', async (req, res) => res.json(await manage.createCommunity({
    subject: str(req.body.subject, 100), description: str(req.body.description, 2048)
})));
r.post('/communities/:jid/link', async (req, res) => {
    if (!req.body.groupJid) throw bad('groupJid is required');
    await manage.linkGroup(String(req.body.groupJid), req.params.jid, bool(req.body.unlink));
    res.json(manage.listAll());
});

r.get('/jobs', (req, res) => res.json(manage.listJobs()));

// ---------- auto replies ----------

const cleanRule = (b, prev = {}) => ({
    ...prev,
    name: str(b.name ?? prev.name, 100),
    enabled: b.enabled === undefined ? prev.enabled ?? true : bool(b.enabled),
    trigger: str(b.trigger ?? prev.trigger, 500),
    matchType: ['exact', 'contains', 'startsWith', 'regex'].includes(b.matchType) ? b.matchType : prev.matchType || 'contains',
    caseSensitive: b.caseSensitive === undefined ? !!prev.caseSensitive : bool(b.caseSensitive),
    response: str(b.response ?? prev.response, 4096),
    groups: b.groups === undefined ? prev.groups || [] : jidList(b.groups),
    cooldownSec: Math.max(0, Number(b.cooldownSec ?? prev.cooldownSec ?? 30) || 0),
    quote: b.quote === undefined ? prev.quote ?? true : bool(b.quote)
});

r.get('/auto-replies', (req, res) => res.json(db.data.autoReplies));
r.post('/auto-replies', (req, res) => {
    const rule = { id: db.id(), hits: 0, createdAt: new Date().toISOString(), ...cleanRule(req.body) };
    if (!rule.trigger || !rule.response) throw bad('Trigger and response are required');
    if (rule.matchType === 'regex') { try { new RegExp(rule.trigger); } catch { throw bad('Invalid regular expression'); } }
    db.data.autoReplies.push(rule); db.save(); res.json(rule);
});
r.put('/auto-replies/:id', (req, res) => {
    const i = db.data.autoReplies.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw bad('Not found', 404);
    db.data.autoReplies[i] = cleanRule(req.body, db.data.autoReplies[i]); db.save();
    res.json(db.data.autoReplies[i]);
});
r.delete('/auto-replies/:id', (req, res) => {
    db.data.autoReplies = db.data.autoReplies.filter((x) => x.id !== req.params.id); db.save(); res.json({ ok: true });
});

// ---------- moderation / welcome / lead capture ----------

r.get('/moderation', (req, res) => { const { warnings, ...m } = db.data.moderation; res.json({ ...m, activeWarnings: Object.keys(warnings).length }); });
r.put('/moderation', (req, res) => {
    const b = req.body, m = db.data.moderation;
    const words = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 500);
    Object.assign(m, {
        enabled: bool(b.enabled), groups: jidList(b.groups), exemptAdmins: bool(b.exemptAdmins),
        antiLink: bool(b.antiLink), allowedDomains: words(b.allowedDomains),
        antiSpam: bool(b.antiSpam),
        spamMaxMessages: Math.max(2, Number(b.spamMaxMessages) || 6),
        spamWindowSec: Math.max(2, Number(b.spamWindowSec) || 10),
        bannedWords: words(b.bannedWords),
        action: ['delete', 'warn', 'remove'].includes(b.action) ? b.action : 'delete',
        maxWarnings: Math.max(1, Number(b.maxWarnings) || 3),
        warnText: str(b.warnText, 1000) || m.warnText
    });
    if (bool(b.resetWarnings)) m.warnings = {};
    db.save(); res.json({ ok: true });
});

r.get('/welcome', (req, res) => res.json(db.data.welcome));
r.put('/welcome', (req, res) => {
    const b = req.body;
    Object.assign(db.data.welcome, {
        enabled: bool(b.enabled), goodbyeEnabled: bool(b.goodbyeEnabled), groups: jidList(b.groups),
        welcomeText: str(b.welcomeText, 4096), goodbyeText: str(b.goodbyeText, 4096)
    });
    db.save(); res.json(db.data.welcome);
});

r.get('/lead-capture', (req, res) => res.json(db.data.leadCapture));
r.put('/lead-capture', (req, res) => {
    db.data.leadCapture.enabled = bool(req.body.enabled); db.save();
    if (db.data.leadCapture.enabled && wa.status === 'connected') captureAll();
    res.json(db.data.leadCapture);
});

// ---------- leads ----------

r.get('/leads', (req, res) => {
    const q = str(req.query.q, 100).toLowerCase();
    const group = str(req.query.group, 100);
    let rows = Object.values(db.data.leads);
    if (group) rows = rows.filter((l) => l.groups[group] !== undefined);
    if (q) rows = rows.filter((l) => (l.name || '').toLowerCase().includes(q) || (l.phone || '').includes(q.replace(/\D/g, '') || '\u0000'));
    rows.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    const page = Math.max(1, Number(req.query.page) || 1), size = 50;
    res.json({ total: rows.length, page, pageSize: size, rows: rows.slice((page - 1) * size, page * size) });
});
r.get('/leads/export', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="wa-group-leads.csv"');
    res.send(leadsCsv(str(req.query.group, 100) || null));
});
r.delete('/leads', (req, res) => { db.data.leads = {}; db.save(); res.json({ ok: true }); });

// ---------- analytics ----------

r.get('/analytics', (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const s = summary({ jid: str(req.query.jid, 100) || null, days });
    s.topMembers = s.topMembers.map((m) => ({ ...m, phone: jidToPhone(m.key) || (/^\d+$/.test(m.key) ? m.key : null) }));
    s.leadCount = Object.keys(db.data.leads).length;
    res.json(s);
});

// ---------- broadcasts ----------

const mediaKind = (mime = '') => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document');

r.get('/broadcasts', (req, res) => res.json(
    [...db.data.broadcasts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicView)
));
r.post('/broadcasts', upload.single('media'), (req, res) => {
    const b = req.body;
    let targets;
    try { targets = jidList(typeof b.targets === 'string' ? JSON.parse(b.targets) : b.targets); } catch { targets = []; }
    if (!targets.length) throw bad('Pick at least one group');
    if (!str(b.text).trim() && !req.file) throw bad('Write a message or attach media');

    const scheduleAt = b.scheduleAt ? new Date(b.scheduleAt) : null;
    if (scheduleAt && Number.isNaN(scheduleAt.getTime())) throw bad('Invalid schedule time');
    const repeat = ['none', 'daily', 'weekly'].includes(b.repeat) ? b.repeat : 'none';

    let customVars = {};
    try {
        if (typeof b.customVars === 'string') customVars = JSON.parse(b.customVars);
        else if (b.customVars && typeof b.customVars === 'object') customVars = b.customVars;
    } catch { customVars = {}; }

    const bc = {
        id: db.id(),
        name: str(b.name, 100) || `Broadcast ${new Date().toLocaleString()}`,
        text: str(b.text, 4096),
        media: req.file ? { path: req.file.path, mimetype: req.file.mimetype, fileName: req.file.originalname, kind: mediaKind(req.file.mimetype) } : null,
        mentionAll: bool(b.mentionAll),
        targets,
        customVars,
        repeat,
        status: 'scheduled',
        nextRunAt: (scheduleAt || new Date()).toISOString(),
        cursor: 0,
        progress: { total: targets.length, sent: 0, failed: 0 },
        log: [],
        runs: 0,
        createdAt: new Date().toISOString()
    };
    db.data.broadcasts.push(bc); db.save(); kick();
    res.json(publicView(bc));
});
const findBc = (id) => db.data.broadcasts.find((x) => x.id === id) || (() => { throw bad('Not found', 404); })();
r.post('/broadcasts/:id/cancel', (req, res) => {
    const b = findBc(req.params.id);
    if (['scheduled', 'running'].includes(b.status)) b.status = 'cancelled';
    db.save(); res.json(publicView(b));
});
r.post('/broadcasts/:id/run-now', (req, res) => {
    const b = findBc(req.params.id);
    if (isRunning(b.id)) throw bad('Already running');
    const finished = b.cursor >= b.targets.length || ['done', 'failed'].includes(b.status);
    if (finished) Object.assign(b, { cursor: 0, progress: { total: b.targets.length, sent: 0, failed: 0 } });
    Object.assign(b, { status: 'scheduled', nextRunAt: new Date().toISOString() });
    db.save(); kick(); res.json(publicView(b));
});
r.delete('/broadcasts/:id', (req, res) => {
    const b = findBc(req.params.id);
    if (isRunning(b.id)) throw bad('Cancel it before deleting');
    const stillUsed = b.media && db.data.broadcasts.some((x) => x.id !== b.id && x.media?.path === b.media.path);
    if (b.media && !stillUsed) fs.rm(b.media.path, { force: true }, () => { });
    db.data.broadcasts = db.data.broadcasts.filter((x) => x.id !== b.id); db.save();
    res.json({ ok: true });
});

export default r;
