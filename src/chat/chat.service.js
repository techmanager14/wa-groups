// Chat service: stores live message history, manages unread counts,
// and formats WhatsApp-style chat list and conversation threads.
import { EventEmitter } from 'events';
import fs from 'fs';
import { db } from '../db.js';
import { wa } from '../wa/session.js';
import { resolveGroupVariables } from '../wa/util.js';

const MAX_PER_CHAT = 150;

class ChatService extends EventEmitter {
    constructor() {
        super();
        this.activeChatJid = null;
    }

    recordMessage(m) {
        const chatJid = m.groupJid || m.raw?.key?.remoteJid;
        if (!chatJid) return;

        const store = (db.data.messages ||= {});
        const list = (store[chatJid] ||= []);

        const msgObj = {
            id: m.raw?.key?.id || db.id(),
            chatJid,
            sender: m.sender || (m.fromMe ? (wa.me?.id || 'me') : ''),
            senderName: m.pushName || (m.fromMe ? 'You' : ''),
            fromMe: !!m.fromMe,
            text: m.text || '',
            timestamp: m.timestamp || Date.now(),
            media: m.media || null
        };

        // Deduplicate in case Baileys emits retry/upsert
        const idx = list.findIndex((x) => x.id === msgObj.id);
        if (idx >= 0) list[idx] = msgObj;
        else list.push(msgObj);

        if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);

        if (!m.fromMe && chatJid !== this.activeChatJid) {
            db.data.unread ||= {};
            db.data.unread[chatJid] = (db.data.unread[chatJid] || 0) + 1;
        }

        db.save();
        this.emit('message', msgObj);
        return msgObj;
    }

    recordSentMessage(chatJid, content, extra = {}) {
        const text = typeof content === 'string' ? content : (content.text || content.caption || '');
        let media = null;
        if (content.image?.url) media = { kind: 'image', url: content.image.url };
        else if (content.video?.url) media = { kind: 'video', url: content.video.url };
        else if (content.audio?.url) media = { kind: 'audio', url: content.audio.url };
        else if (content.document?.url) media = { kind: 'document', fileName: content.fileName || 'file', url: content.document.url };

        return this.recordMessage({
            raw: { key: { id: extra.id || db.id(), remoteJid: chatJid, fromMe: true } },
            groupJid: chatJid,
            sender: wa.me?.id || 'me',
            pushName: wa.me?.name || 'You',
            fromMe: true,
            text,
            media,
            timestamp: Date.now()
        });
    }

    getChatMessages(chatJid) {
        return (db.data.messages?.[chatJid] || []).slice();
    }

    markRead(chatJid) {
        if (db.data.unread?.[chatJid]) {
            delete db.data.unread[chatJid];
            db.save();
            this.emit('read', { chatJid });
        }
    }

    setActiveChat(chatJid) {
        this.activeChatJid = chatJid;
        if (chatJid) this.markRead(chatJid);
    }

    /** Returns all known chats (groups and communities) with their last message & unread count */
    getChatsList() {
        const all = [...wa.groups.values()];
        const messages = db.data.messages || {};
        const unread = db.data.unread || {};

        const chats = all.map((g) => {
            const list = messages[g.id] || [];
            const lastMessage = list[list.length - 1] || null;
            return {
                jid: g.id,
                subject: g.subject || '(no name)',
                desc: g.desc || '',
                size: g.participants?.length ?? g.size ?? 0,
                isCommunity: !!g.isCommunity,
                isCommunityAnnounce: !!g.isCommunityAnnounce,
                linkedParent: g.linkedParent || null,
                announce: !!g.announce,
                iAmAdmin: wa.amIAdmin(g),
                lastMessage: lastMessage ? {
                    id: lastMessage.id,
                    text: lastMessage.text,
                    fromMe: lastMessage.fromMe,
                    senderName: lastMessage.senderName,
                    timestamp: lastMessage.timestamp,
                    hasMedia: !!lastMessage.media
                } : null,
                unread: unread[g.id] || 0
            };
        });

        // Sort chats by most recent message, then alphabetically
        return chats.sort((a, b) => {
            const timeA = a.lastMessage?.timestamp || (a.isCommunity ? 2 : 1);
            const timeB = b.lastMessage?.timestamp || (b.isCommunity ? 2 : 1);
            return timeB - timeA || a.subject.localeCompare(b.subject);
        });
    }

    async sendChatMessage(chatJid, { text = '', file = null, customVars = {} }) {
        const meta = wa.groups.get(chatJid) || { subject: chatJid };
        const resolvedText = resolveGroupVariables(text, meta, customVars);

        let content;
        if (file && fs.existsSync(file.path)) {
            const base = { caption: resolvedText || undefined, mimetype: file.mimetype };
            if (file.mimetype.startsWith('image/')) content = { image: { url: file.path }, ...base };
            else if (file.mimetype.startsWith('video/')) content = { video: { url: file.path }, ...base };
            else if (file.mimetype.startsWith('audio/')) content = { audio: { url: file.path }, mimetype: file.mimetype };
            else content = { document: { url: file.path }, fileName: file.originalname, ...base };
        } else {
            content = { text: resolvedText };
        }

        const res = await wa.send(chatJid, content);
        const msgObj = this.recordSentMessage(chatJid, content, { id: res?.key?.id });
        return { ok: true, message: msgObj };
    }
}

export const chatService = new ChatService();
