// Bulk / scheduled broadcasts to many groups (and community announcement groups).
// One broadcast runs at a time; each target is sent with a random human-like delay.
// Progress is persisted with a cursor so a restart resumes instead of re-sending.
import fs from 'fs';
import { db } from '../db.js';
import { config } from '../config.js';
import { wa } from '../wa/session.js';
import { humanDelay, resolveGroupVariables } from '../wa/util.js';

const TICK_MS = 15000;
let running = null;
let notify = () => { };

export function onBroadcastChange(fn) { notify = fn; }

function emit(b) { notify(publicView(b)); }

export function publicView(b) {
    const { log, ...rest } = b;
    return { ...rest, log: (log || []).slice(-200) };
}

export function nextRun(b) {
    if (!b.nextRunAt) return null;
    const d = new Date(b.nextRunAt);
    if (b.repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (b.repeat === 'weekly') d.setDate(d.getDate() + 7);
    else return null;
    // Skip forward if the app was offline across several periods.
    while (d.getTime() < Date.now()) d.setDate(d.getDate() + (b.repeat === 'daily' ? 1 : 7));
    return d.toISOString();
}

function buildContent(b, meta) {
    const text = resolveGroupVariables(b.text || '', meta, b.customVars || {});
    const mentions = b.mentionAll ? (meta?.participants || []).map((p) => p.id).filter((j) => !wa.isMe(j)) : undefined;
    const m = b.media;
    if (m && fs.existsSync(m.path)) {
        const base = { caption: text || undefined, mentions, mimetype: m.mimetype };
        if (m.kind === 'image') return { image: { url: m.path }, ...base };
        if (m.kind === 'video') return { video: { url: m.path }, ...base };
        if (m.kind === 'audio') return { audio: { url: m.path }, mimetype: m.mimetype };
        return { document: { url: m.path }, fileName: m.fileName, ...base };
    }
    return { text, mentions };
}

async function run(b) {
    running = b.id;
    b.status = 'running';
    b.cursor ||= 0;
    b.progress = { total: b.targets.length, sent: b.progress?.sent || 0, failed: b.progress?.failed || 0 };
    b.lastRunAt = new Date().toISOString();
    db.save(); emit(b);

    try {
        for (; b.cursor < b.targets.length; b.cursor++) {
            if (b.status !== 'running') return; // cancelled / paused mid-run
            if (wa.status !== 'connected') { b.status = 'scheduled'; return; } // retry on next tick

            const jid = b.targets[b.cursor];
            const meta = wa.groups.get(jid);
            const entry = { jid, subject: meta?.subject || jid, at: new Date().toISOString() };
            try {
                if (!meta) throw new Error('not a member of this group anymore');
                if (meta.announce && !wa.amIAdmin(meta)) throw new Error('only admins can send messages');
                await wa.send(jid, buildContent(b, meta));
                b.progress.sent++;
                entry.ok = true;
            } catch (e) {
                b.progress.failed++;
                entry.ok = false;
                entry.error = e.message;
            }
            (b.log ||= []).push(entry);
            db.save(); emit(b);

            if (b.cursor < b.targets.length - 1) await humanDelay(config.minDelayMs, config.maxDelayMs);
        }

        const next = nextRun(b);
        if (next) {
            Object.assign(b, { status: 'scheduled', nextRunAt: next, cursor: 0, progress: { total: b.targets.length, sent: 0, failed: 0 } });
            b.runs = (b.runs || 0) + 1;
        } else {
            b.status = b.progress.sent === 0 && b.progress.failed > 0 ? 'failed' : 'done';
            b.runs = (b.runs || 0) + 1;
        }
    } catch (e) {
        b.status = 'failed';
        b.error = e.message;
    } finally {
        running = null;
        db.save(); emit(b);
    }
}

function tick() {
    if (running || wa.status !== 'connected') return;
    const now = Date.now();
    const due = db.data.broadcasts
        .filter((b) => b.status === 'scheduled' && (!b.nextRunAt || new Date(b.nextRunAt).getTime() <= now))
        .sort((a, b) => new Date(a.nextRunAt || 0) - new Date(b.nextRunAt || 0))[0];
    if (due) run(due);
}

export function kick() { setTimeout(tick, 200); }

export function startScheduler() {
    // A crash mid-run leaves status 'running'; resume from the saved cursor.
    for (const b of db.data.broadcasts) if (b.status === 'running') b.status = 'scheduled';
    db.save();
    setInterval(tick, TICK_MS);
    wa.on('status', (s) => { if (s.status === 'connected') kick(); });
}

export function isRunning(id) { return running === id; }
