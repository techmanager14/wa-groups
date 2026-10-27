// Tiny JSON-file store. The app is single-tenant and low-write, so a debounced,
// atomically-renamed JSON file is plenty and keeps the app dependency-free
// (no MongoDB / Redis / native SQLite build on Windows).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'db.json');

const DEFAULTS = () => ({
    autoReplies: [],
    moderation: {
        enabled: false,
        groups: [],               // empty = all groups where we are admin
        exemptAdmins: true,
        antiLink: true,
        allowedDomains: [],
        antiSpam: true,
        spamMaxMessages: 6,
        spamWindowSec: 10,
        bannedWords: [],
        action: 'delete',         // delete | warn | remove
        maxWarnings: 3,
        warnText: '⚠️ @user, that is not allowed here ({reason}). Warning {count}/{max}.',
        warnings: {}              // `${groupJid}|${userJid}` -> count
    },
    welcome: {
        enabled: false,
        groups: [],               // empty = all groups
        welcomeText: '👋 Welcome @user to *{group}*! Please read the group description.',
        goodbyeEnabled: false,
        goodbyeText: '👋 @user has left {group}.'
    },
    leadCapture: {
        enabled: true             // auto-save every group member/sender as a lead
    },
    broadcasts: [],
    leads: {},                    // userJid -> lead
    stats: {}                     // groupJid -> { days: { 'YYYY-MM-DD': { messages, joins, leaves, size, senders } } }
});

let data;
let timer = null;

function load() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (fs.existsSync(FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            const def = DEFAULTS();
            // Shallow-merge so new settings keys appear after upgrades.
            data = { ...def, ...parsed };
            for (const k of ['moderation', 'welcome', 'leadCapture']) {
                data[k] = { ...def[k], ...(parsed[k] || {}) };
            }
            return;
        } catch (err) {
            const bad = `${FILE}.corrupt-${Date.now()}`;
            fs.renameSync(FILE, bad);
            console.error(`[db] db.json was unreadable, moved to ${bad}: ${err.message}`);
        }
    }
    data = DEFAULTS();
    flush();
}

function flush() {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
}

export const db = {
    get data() { return data; },
    save() {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            try { flush(); } catch (err) { console.error('[db] write failed:', err.message); }
        }, 400);
    },
    flushNow() {
        if (timer) { clearTimeout(timer); timer = null; }
        flush();
    },
    id: () => crypto.randomUUID()
};

load();
