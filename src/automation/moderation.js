// Moderation: anti-link, anti-spam (flood), banned words.
// Actions: delete | warn (delete + warn, remove at max) | remove (delete + kick).
// Requires this account to be a group admin; silently skips otherwise.
import { db } from '../db.js';
import { wa } from '../wa/session.js';
import { fill, userPart } from '../wa/util.js';

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s]+|chat\.whatsapp\.com\/[^\s]+|[a-z0-9-]+\.(?:com|net|org|in|io|co|me|ly|gg|xyz|info|biz|app|link|site|online|shop|store)(?:\/[^\s]*)?)/gi;
const floods = new Map(); // `${group}|${sender}` -> timestamps[]

const inScope = (list, jid) => !list?.length || list.includes(jid);

function linkViolation(text, allowed) {
    const found = text.match(URL_RE);
    if (!found) return null;
    const allow = (allowed || []).map((d) => d.toLowerCase().trim()).filter(Boolean);
    const bad = found.find((u) => {
        const host = u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
        return !allow.some((d) => host === d || host.endsWith(`.${d}`));
    });
    return bad ? 'links are not allowed' : null;
}

function wordViolation(text, words) {
    const lower = text.toLowerCase();
    const hit = (words || []).map((w) => w.trim().toLowerCase()).filter(Boolean).find((w) => {
        const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(lower);
    });
    return hit ? 'banned word' : null;
}

function floodViolation(key, max, windowSec) {
    const now = Date.now();
    const arr = (floods.get(key) || []).filter((t) => now - t < windowSec * 1000);
    arr.push(now);
    floods.set(key, arr);
    return arr.length > max ? 'flooding / spam' : null;
}

/** @returns {Promise<boolean>} true when the message was moderated (stop further processing) */
export async function moderate(m) {
    const cfg = db.data.moderation;
    if (!cfg.enabled || m.fromMe || !m.sender || !inScope(cfg.groups, m.groupJid)) return false;

    const meta = wa.groups.get(m.groupJid);
    if (!wa.amIAdmin(meta)) return false;
    if (cfg.exemptAdmins && wa.isAdmin(meta, m.sender)) return false;

    const text = m.text || '';
    const reason =
        (cfg.antiLink && text && linkViolation(text, cfg.allowedDomains)) ||
        (text && wordViolation(text, cfg.bannedWords)) ||
        (cfg.antiSpam && floodViolation(`${m.groupJid}|${m.sender}`, cfg.spamMaxMessages, cfg.spamWindowSec));
    if (!reason) return false;

    console.log(`[mod] ${meta?.subject}: ${m.sender} — ${reason}`);
    try { await wa.send(m.groupJid, { delete: m.raw.key }); } catch (e) { console.error('[mod] delete failed:', e.message); }

    if (cfg.action === 'remove') {
        await kick(m.groupJid, m.sender);
    } else if (cfg.action === 'warn') {
        const wKey = `${m.groupJid}|${m.sender}`;
        const count = (cfg.warnings[wKey] || 0) + 1;
        cfg.warnings[wKey] = count;
        db.save();
        if (count >= cfg.maxWarnings) {
            delete cfg.warnings[wKey];
            db.save();
            await kick(m.groupJid, m.sender);
        } else {
            const text = fill(cfg.warnText, { reason, count, max: cfg.maxWarnings, group: meta?.subject || '' })
                .replace(/@user/g, `@${userPart(m.sender)}`);
            await wa.send(m.groupJid, { text, mentions: [m.sender] }).catch(() => { });
        }
    }
    return true;
}

async function kick(groupJid, jid) {
    try {
        await wa.requireSock().groupParticipantsUpdate(groupJid, [jid], 'remove');
    } catch (e) {
        console.error('[mod] remove failed:', e.message);
    }
}
