// Single WhatsApp (Baileys) session: QR login, auto-reconnect, group cache,
// and a serialized outgoing send queue. Automation modules subscribe to the
// normalized events emitted here instead of touching the socket directly.
import { EventEmitter } from 'events';
import fs from 'fs';
import pino from 'pino';
import QRCode from 'qrcode';
import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers,
    isJidGroup
} from 'baileys';
import { config } from '../config.js';
import { sleep, extractText, areJidsSameUser } from './util.js';

const logger = pino({ level: process.env.BAILEYS_LOG || 'silent' });
const MAX_RECONNECTS = 6;
const SEND_GAP_MS = 1200; // floor between ANY two automated sends

class WhatsAppSession extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.status = 'disconnected'; // disconnected | connecting | qr | connected
        this.qr = null;
        this.me = null;
        this.groups = new Map();      // jid -> GroupMetadata
        this.attempts = 0;
        this.starting = false;
        this.sendChain = Promise.resolve();
        this.lastSendAt = 0;
    }

    setStatus(status, extra = {}) {
        this.status = status;
        if (status !== 'qr') this.qr = null;
        this.emit('status', this.publicState(extra));
    }

    publicState(extra = {}) {
        return {
            status: this.status,
            qr: this.qr,
            me: this.me,
            groupCount: [...this.groups.values()].filter((g) => !g.isCommunity).length,
            communityCount: [...this.groups.values()].filter((g) => g.isCommunity).length,
            ...extra
        };
    }

    hasSession() {
        return fs.existsSync(`${config.sessionDir}/creds.json`);
    }

    async connect({ force = false } = {}) {
        if (this.starting) return;
        if (this.sock && !force && this.status !== 'disconnected') return;
        if (this.sock) this.teardown();
        this.starting = true;

        try {
            fs.mkdirSync(config.sessionDir, { recursive: true });
            const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
            let version;
            try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* fall back to bundled version */ }

            this.setStatus('connecting');
            const sock = makeWASocket({
                ...(version ? { version } : {}),
                logger,
                browser: Browsers.windows('WA-Groups'),
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
                markOnlineOnConnect: false,
                syncFullHistory: false,
                // Without this Baileys re-fetches group metadata on every group send,
                // which is slow and a rate-limit risk during broadcasts.
                cachedGroupMetadata: async (jid) => this.groups.get(jid),
                getMessage: async () => undefined
            });
            this.sock = sock;

            sock.ev.on('creds.update', saveCreds);
            sock.ev.on('connection.update', (u) => this.onConnectionUpdate(sock, u).catch((e) =>
                console.error('[wa] connection.update handler failed:', e.message)));

            sock.ev.on('messages.upsert', ({ messages, type }) => {
                if (type !== 'notify') return;
                for (const raw of messages) this.onMessage(raw);
            });

            sock.ev.on('group-participants.update', (ev) => this.onParticipants(ev).catch((e) =>
                console.error('[wa] participants handler failed:', e.message)));

            sock.ev.on('groups.upsert', (list) => {
                for (const g of list) this.groups.set(g.id, g);
                this.emit('groups', { reason: 'upsert' });
            });

            sock.ev.on('groups.update', (list) => {
                for (const patch of list) {
                    const cur = this.groups.get(patch.id);
                    if (cur) this.groups.set(patch.id, { ...cur, ...patch });
                }
                this.emit('groups', { reason: 'update' });
            });
        } finally {
            this.starting = false;
        }
    }

    async onConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
        if (sock !== this.sock) return; // event from a socket we already replaced

        if (qr) {
            this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
            this.setStatus('qr');
        }

        if (connection === 'open') {
            this.attempts = 0;
            this.me = { id: sock.user?.id, lid: sock.user?.lid, name: sock.user?.name || sock.user?.verifiedName || '' };
            console.log(`[wa] connected as ${this.me.id}`);
            this.setStatus('connected');
            await this.refreshGroups().catch((e) => console.error('[wa] initial group sync failed:', e.message));
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            const restart = code === DisconnectReason.restartRequired;
            this.teardown();

            if (loggedOut) {
                console.log('[wa] logged out — clearing session');
                this.clearSession();
                this.setStatus('disconnected', { reason: 'logged_out' });
                return;
            }
            if (this.attempts >= MAX_RECONNECTS) {
                console.warn('[wa] reconnect budget exhausted; reconnect manually from the dashboard');
                this.setStatus('disconnected', { reason: 'reconnect_failed' });
                return;
            }
            this.attempts += 1;
            this.setStatus('connecting');
            // 515 restartRequired fires right after pairing: reconnect immediately.
            await sleep(restart ? 300 : Math.min(3000 * this.attempts, 30000));
            await this.connect({ force: true });
        }
    }

    teardown() {
        const s = this.sock;
        this.sock = null;
        if (!s) return;
        try { s.ev.removeAllListeners(); } catch { }
        try { s.end(undefined); } catch { }
    }

    clearSession() {
        this.me = null;
        this.groups.clear();
        try { fs.rmSync(config.sessionDir, { recursive: true, force: true }); } catch { }
    }

    async logout() {
        try { await this.sock?.logout(); } catch { }
        this.teardown();
        this.clearSession();
        this.setStatus('disconnected', { reason: 'logged_out' });
    }

    requireSock() {
        if (!this.sock || this.status !== 'connected') {
            const err = new Error('WhatsApp is not connected');
            err.status = 409;
            throw err;
        }
        return this.sock;
    }

    // ---------- groups cache ----------

    async refreshGroups() {
        const sock = this.requireSock();
        const all = await sock.groupFetchAllParticipating();
        const map = new Map(Object.entries(all));
        try {
            const comms = await sock.communityFetchAllParticipating();
            for (const c of Array.isArray(comms) ? comms : Object.values(comms || {})) {
                if (c?.id) map.set(c.id, { ...(map.get(c.id) || {}), ...c, isCommunity: true });
            }
        } catch (e) {
            console.warn('[wa] community fetch failed (continuing with groups only):', e.message);
        }
        this.groups = map;
        this.emit('groups', { reason: 'sync' });
        this.emit('status', this.publicState());
        return this.groups;
    }

    async getGroup(jid, { fresh = false } = {}) {
        if (!fresh && this.groups.has(jid)) return this.groups.get(jid);
        const meta = await this.requireSock().groupMetadata(jid);
        this.groups.set(jid, meta);
        return meta;
    }

    isMe(jid) {
        if (!this.me || !jid) return false;
        return areJidsSameUser(jid, this.me.id) || (this.me.lid && areJidsSameUser(jid, this.me.lid));
    }

    amIAdmin(meta) {
        if (!meta) return false;
        return meta.participants?.some((p) => (this.isMe(p.id) || this.isMe(p.phoneNumber) || this.isMe(p.lid)) && p.admin);
    }

    isAdmin(meta, jid) {
        return !!meta?.participants?.some((p) =>
            (areJidsSameUser(p.id, jid) || areJidsSameUser(p.phoneNumber, jid) || areJidsSameUser(p.lid, jid)) && p.admin);
    }

    findParticipant(meta, jid) {
        return meta?.participants?.find((p) =>
            areJidsSameUser(p.id, jid) || areJidsSameUser(p.phoneNumber, jid) || areJidsSameUser(p.lid, jid));
    }

    // ---------- events ----------

    onMessage(raw) {
        const groupJid = raw.key?.remoteJid;
        if (!groupJid || !isJidGroup(groupJid) || !raw.message) return;
        if (raw.message.protocolMessage || raw.message.reactionMessage) return;

        const sender = raw.key.participant;
        const alt = raw.key.participantAlt;
        this.emit('message', {
            raw,
            groupJid,
            sender,
            senderAlt: alt,
            pushName: raw.pushName || '',
            fromMe: !!raw.key.fromMe,
            text: extractText(raw.message),
            timestamp: Number(raw.messageTimestamp) * 1000 || Date.now()
        });
    }

    async onParticipants(ev) {
        // Keep the cached participant list in step so admin checks / mentions stay right.
        try { await this.getGroup(ev.id, { fresh: true }); } catch { }
        this.emit('participants', ev);
        this.emit('groups', { reason: 'participants' });
    }

    // ---------- sending ----------

    /** Serialized, rate-floored send. Every automated message goes through here. */
    send(jid, content, options = {}) {
        const run = async () => {
            const sock = this.requireSock();
            const wait = this.lastSendAt + SEND_GAP_MS - Date.now();
            if (wait > 0) await sleep(wait);
            try {
                return await sock.sendMessage(jid, content, options);
            } finally {
                this.lastSendAt = Date.now();
            }
        };
        const p = this.sendChain.then(run, run);
        this.sendChain = p.catch(() => { });
        return p;
    }
}

export const wa = new WhatsAppSession();
