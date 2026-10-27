// Keyword auto-replies inside groups, plus welcome / goodbye messages.
import { db } from '../db.js';
import { wa } from '../wa/session.js';
import { fill, userPart } from '../wa/util.js';

const inScope = (list, jid) => !list?.length || list.includes(jid);
const cooldowns = new Map(); // `${ruleId}|${group}` -> last reply ts

function matches(rule, text) {
    const t = text.trim();
    const k = String(rule.trigger || '').trim();
    if (!k) return false;
    const a = rule.caseSensitive ? t : t.toLowerCase();
    const b = rule.caseSensitive ? k : k.toLowerCase();
    switch (rule.matchType) {
        case 'exact': return a === b;
        case 'startsWith': return a.startsWith(b);
        case 'regex':
            try { return new RegExp(k, rule.caseSensitive ? '' : 'i').test(t); } catch { return false; }
        case 'contains':
        default: return a.includes(b);
    }
}

export async function autoReply(m) {
    if (m.fromMe || !m.text) return;
    const meta = wa.groups.get(m.groupJid);
    for (const rule of db.data.autoReplies) {
        if (!rule.enabled || !inScope(rule.groups, m.groupJid) || !matches(rule, m.text)) continue;

        const cdKey = `${rule.id}|${m.groupJid}`;
        const last = cooldowns.get(cdKey) || 0;
        if (Date.now() - last < (Number(rule.cooldownSec) || 0) * 1000) continue;
        cooldowns.set(cdKey, Date.now());

        let text = fill(rule.response, { name: m.pushName || 'there', group: meta?.subject || '' });
        const mentions = [];
        if (/@user/.test(text)) {
            text = text.replace(/@user/g, `@${userPart(m.sender)}`);
            mentions.push(m.sender);
        }
        try {
            await wa.send(m.groupJid, { text, mentions }, rule.quote !== false ? { quoted: m.raw } : {});
            rule.hits = (rule.hits || 0) + 1;
            db.save();
        } catch (e) {
            console.error('[auto-reply] send failed:', e.message);
        }
        break; // first matching rule wins
    }
}

export async function welcome(ev) {
    const cfg = db.data.welcome;
    if (!cfg.enabled && !cfg.goodbyeEnabled) return;
    if (!inScope(cfg.groups, ev.id)) return;

    const isJoin = ev.action === 'add';
    const isLeave = ev.action === 'remove';
    if ((isJoin && !cfg.enabled) || (isLeave && !cfg.goodbyeEnabled) || (!isJoin && !isLeave)) return;

    // Baileys 7 sends participant objects; older builds sent plain jids.
    const people = (ev.participants || [])
        .map((p) => (typeof p === 'string' ? p : p?.id))
        .filter((j) => j && !wa.isMe(j));
    if (!people.length) return;

    const meta = wa.groups.get(ev.id);
    const tags = people.map((j) => `@${userPart(j)}`).join(', ');
    const tpl = isJoin ? cfg.welcomeText : cfg.goodbyeText;
    const text = fill(tpl, { group: meta?.subject || '', count: meta?.participants?.length ?? '' }).replace(/@user/g, tags);

    try {
        await wa.send(ev.id, { text, mentions: people });
    } catch (e) {
        console.error('[welcome] send failed:', e.message);
    }
}
