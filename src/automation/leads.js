// Lead capture: every member we see (on group sync, join, or message) becomes a
// contact keyed by phone number when known, otherwise by LID.
import { db } from '../db.js';
import { wa } from '../wa/session.js';
import { jidToPhone, participantPn, isLidUser } from '../wa/util.js';

function keyFor(jid, phone) {
    return phone || jid;
}

function upsert({ jid, phone, name, groupJid, groupName, source, countMessage = false }) {
    if (!db.data.leadCapture.enabled || !jid || wa.isMe(jid)) return;
    const key = keyFor(jid, phone);
    const now = new Date().toISOString();
    const leads = db.data.leads;

    // A member first seen by LID can later reveal a phone number: merge the records.
    if (phone && leads[jid] && jid !== key) {
        leads[key] = { ...leads[jid], ...(leads[key] || {}), groups: { ...leads[jid].groups, ...(leads[key]?.groups || {}) } };
        delete leads[jid];
    }

    const lead = leads[key] || (leads[key] = { key, jid, phone: phone || null, name: '', groups: {}, messages: 0, source, firstSeen: now });
    if (phone) lead.phone = phone;
    if (!isLidUser(jid) || !lead.jid) lead.jid = jid;
    if (name && name.trim()) lead.name = name.trim();
    if (groupJid) lead.groups[groupJid] = groupName || lead.groups[groupJid] || '';
    if (countMessage) lead.messages += 1;
    lead.lastSeen = now;
}

export function resolvePhone(groupJid, sender, senderAlt) {
    return (
        jidToPhone(sender) ||
        jidToPhone(senderAlt) ||
        jidToPhone(participantPn(wa.findParticipant(wa.groups.get(groupJid), sender)))
    );
}

export function captureFromMessage(m) {
    if (m.fromMe || !m.sender) return;
    const meta = wa.groups.get(m.groupJid);
    upsert({
        jid: m.sender,
        phone: resolvePhone(m.groupJid, m.sender, m.senderAlt),
        name: m.pushName,
        groupJid: m.groupJid,
        groupName: meta?.subject,
        source: 'message',
        countMessage: true
    });
    db.save();
}

export function captureGroup(meta, source = 'sync') {
    if (!meta?.participants) return;
    for (const p of meta.participants) {
        upsert({
            jid: p.id,
            phone: jidToPhone(participantPn(p)),
            name: p.name || p.notify,
            groupJid: meta.id,
            groupName: meta.subject,
            source
        });
    }
}

export function captureAll() {
    if (!db.data.leadCapture.enabled) return;
    for (const meta of wa.groups.values()) captureGroup(meta);
    db.save();
}

const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows, columns) {
    const head = columns.map((c) => csvCell(c.label)).join(',');
    const body = rows.map((r) => columns.map((c) => csvCell(c.get(r))).join(','));
    // BOM so Excel opens UTF-8 names (emoji, Devanagari, …) correctly.
    return '\uFEFF' + [head, ...body].join('\r\n');
}

export function leadsCsv(filterGroup) {
    let rows = Object.values(db.data.leads);
    if (filterGroup) rows = rows.filter((l) => l.groups[filterGroup] !== undefined);
    return toCsv(rows, [
        { label: 'Name', get: (l) => l.name },
        { label: 'Phone', get: (l) => (l.phone ? `+${l.phone}` : '') },
        { label: 'WhatsApp ID', get: (l) => l.jid },
        { label: 'Groups', get: (l) => Object.values(l.groups).filter(Boolean).join(' | ') },
        { label: 'Messages', get: (l) => l.messages },
        { label: 'First Seen', get: (l) => l.firstSeen },
        { label: 'Last Seen', get: (l) => l.lastSeen }
    ]);
}
