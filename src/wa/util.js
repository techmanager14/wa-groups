import { jidDecode, isPnUser, isLidUser, areJidsSameUser, normalizeMessageContent } from 'baileys';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const humanDelay = (min, max) => sleep(min + Math.floor(Math.random() * Math.max(0, max - min)));

/** "+91 98765-43210" -> "919876543210@s.whatsapp.net" */
export function phoneToJid(input) {
    const digits = String(input || '').replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return `${digits}@s.whatsapp.net`;
}

/** Phone number digits for a PN jid, else null (LIDs carry no phone number). */
export function jidToPhone(jid) {
    if (!jid || !isPnUser(jid)) return null;
    return jidDecode(jid)?.user || null;
}

export function userPart(jid) {
    return jidDecode(jid)?.user || String(jid || '').split('@')[0];
}

export { isLidUser, areJidsSameUser };

/**
 * Best phone-number jid we can derive for a group participant.
 * Baileys 7 groups may address members by LID; the PN then lives in `phoneNumber`.
 */
export function participantPn(p) {
    if (!p) return null;
    if (isPnUser(p.id)) return p.id;
    if (p.phoneNumber && isPnUser(p.phoneNumber)) return p.phoneNumber;
    return null;
}

export function extractText(message) {
    const m = normalizeMessageContent(message);
    if (!m) return '';
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        ''
    );
}

export function today(d = new Date()) {
    // Local-date key so "today" in analytics matches the operator's wall clock.
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

/** Replace {placeholders} in a template. */
export function fill(template, vars) {
    return String(template || '').replace(/\{([a-zA-Z0-9_-]+)\}/g, (m, k) => {
        const val = vars[k] ?? vars[k.toLowerCase()];
        return val !== undefined ? String(val) : m;
    });
}

/** Rich variable substitution for group messages */
export function resolveGroupVariables(template, meta, extraVars = {}) {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    const size = meta?.participants?.length ?? meta?.size ?? 0;
    const adminCount = (meta?.participants || []).filter((p) => p.admin).length;
    const dateFormatted = now.toLocaleDateString();
    const timeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const baseVars = {
        group: meta?.subject || '',
        group_name: meta?.subject || '',
        name: meta?.subject || '',
        desc: meta?.desc || '',
        description: meta?.desc || '',
        size: String(size),
        count: String(size),
        members_count: String(size),
        admins_count: String(adminCount),
        date: dateFormatted,
        time: timeFormatted,
        day: days[now.getDay()],
        month: months[now.getMonth()],
        year: String(now.getFullYear()),
        ...(extraVars || {})
    };

    return fill(template, baseVars);
}

