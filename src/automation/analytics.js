// Per-group daily counters: messages, joins, leaves, member-count snapshot and
// per-sender message counts (for "top members").
import { db } from '../db.js';
import { config } from '../config.js';
import { wa } from '../wa/session.js';
import { today } from '../wa/util.js';
import { resolvePhone } from './leads.js';

function day(groupJid, date = today()) {
    const g = (db.data.stats[groupJid] ||= { days: {}, names: {} });
    return (g.days[date] ||= { messages: 0, joins: 0, leaves: 0, size: null, senders: {} });
}

export function recordMessage(m) {
    if (m.fromMe) return;
    const d = day(m.groupJid);
    d.messages += 1;
    const key = resolvePhone(m.groupJid, m.sender, m.senderAlt) || m.sender;
    d.senders[key] = (d.senders[key] || 0) + 1;
    if (m.pushName) db.data.stats[m.groupJid].names[key] = m.pushName;
    db.save();
}

export function recordParticipants({ id, action, participants }) {
    const n = participants?.length || 0;
    if (action === 'add') day(id).joins += n;
    else if (action === 'remove') day(id).leaves += n;
    snapshotSize(id);
    db.save();
}

function snapshotSize(jid) {
    const meta = wa.groups.get(jid);
    if (meta) day(jid).size = meta.participants?.length ?? meta.size ?? null;
}

export function snapshotAll() {
    for (const jid of wa.groups.keys()) snapshotSize(jid);
    prune();
    db.save();
}

function prune() {
    const cutoff = today(new Date(Date.now() - config.analyticsRetentionDays * 86400000));
    for (const g of Object.values(db.data.stats)) {
        for (const d of Object.keys(g.days)) if (d < cutoff) delete g.days[d];
    }
}

/** Aggregate stats for one group (or all when jid is null) over the last N days. */
export function summary({ jid = null, days = 30 } = {}) {
    const dates = [];
    for (let i = days - 1; i >= 0; i--) dates.push(today(new Date(Date.now() - i * 86400000)));

    const groups = jid ? [jid] : Object.keys(db.data.stats);
    const series = dates.map((date) => ({ date, messages: 0, joins: 0, leaves: 0, size: 0 }));
    const senders = {};
    const perGroup = [];

    for (const g of groups) {
        const s = db.data.stats[g];
        if (!s) continue;
        let gMessages = 0, gJoins = 0, gLeaves = 0;
        let lastSize = null;
        dates.forEach((date, i) => {
            const d = s.days[date];
            if (d) {
                series[i].messages += d.messages;
                series[i].joins += d.joins;
                series[i].leaves += d.leaves;
                gMessages += d.messages; gJoins += d.joins; gLeaves += d.leaves;
                if (d.size != null) lastSize = d.size;
                for (const [k, c] of Object.entries(d.senders)) {
                    const e = (senders[k] ||= { key: k, name: s.names[k] || '', count: 0 });
                    e.count += c;
                    if (!e.name && s.names[k]) e.name = s.names[k];
                }
            }
            // Carry the last known member count forward so the growth line has no gaps.
            if (lastSize != null) series[i].size += lastSize;
        });
        const meta = wa.groups.get(g);
        perGroup.push({
            jid: g,
            subject: meta?.subject || g,
            size: meta?.participants?.length ?? lastSize ?? 0,
            messages: gMessages, joins: gJoins, leaves: gLeaves
        });
    }

    const totals = series.reduce((a, d) => ({
        messages: a.messages + d.messages, joins: a.joins + d.joins, leaves: a.leaves + d.leaves
    }), { messages: 0, joins: 0, leaves: 0 });

    return {
        days,
        totals,
        series,
        topMembers: Object.values(senders).sort((a, b) => b.count - a.count).slice(0, 15),
        topGroups: perGroup.sort((a, b) => b.messages - a.messages).slice(0, 15)
    };
}
