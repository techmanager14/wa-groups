// Group & community management: listing, create, settings, invite links and
// throttled bulk participant operations that run as background jobs.
import { wa } from './session.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { phoneToJid, jidToPhone, participantPn, humanDelay, areJidsSameUser } from './util.js';

const CHUNK = 5; // participants per WhatsApp request
const jobs = new Map();
let notify = () => { };
export function onJobChange(fn) { notify = fn; }

// ---------- views ----------

export function groupView(g) {
    return {
        jid: g.id,
        subject: g.subject || '(no name)',
        desc: g.desc || '',
        size: g.participants?.length ?? g.size ?? 0,
        admins: (g.participants || []).filter((p) => p.admin).length,
        isCommunity: !!g.isCommunity,
        isCommunityAnnounce: !!g.isCommunityAnnounce,
        linkedParent: g.linkedParent || null,
        announce: !!g.announce,
        restrict: !!g.restrict,
        joinApprovalMode: !!g.joinApprovalMode,
        memberAddMode: !!g.memberAddMode,
        iAmAdmin: wa.amIAdmin(g),
        creation: g.creation ? g.creation * 1000 : null
    };
}

export function listAll() {
    const all = [...wa.groups.values()];
    const communities = all.filter((g) => g.isCommunity).map((c) => ({
        ...groupView(c),
        subgroups: all.filter((g) => g.linkedParent === c.id && !g.isCommunity).map(groupView)
    }));
    const known = new Set(communities.map((c) => c.jid));
    // Sub-groups whose parent community we could not fetch still get a bucket.
    for (const g of all) {
        if (g.linkedParent && !known.has(g.linkedParent)) {
            known.add(g.linkedParent);
            communities.push({
                jid: g.linkedParent, subject: 'Community', desc: '', size: 0, isCommunity: true, iAmAdmin: false,
                subgroups: all.filter((x) => x.linkedParent === g.linkedParent).map(groupView)
            });
        }
    }
    return {
        groups: all.filter((g) => !g.isCommunity).map(groupView).sort((a, b) => a.subject.localeCompare(b.subject)),
        communities: communities.sort((a, b) => a.subject.localeCompare(b.subject))
    };
}

export async function groupDetail(jid) {
    const g = await wa.getGroup(jid, { fresh: true });
    const lead = (k) => db.data.leads[k];
    return {
        ...groupView(g),
        participants: (g.participants || []).map((p) => {
            const phone = jidToPhone(participantPn(p));
            return {
                jid: p.id,
                phone,
                name: p.name || p.notify || lead(phone)?.name || lead(p.id)?.name || '',
                admin: p.admin || null,
                isMe: wa.isMe(p.id) || wa.isMe(p.phoneNumber)
            };
        }).sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0) || a.name.localeCompare(b.name))
    };
}

// ---------- create ----------

const parsePhones = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/))
    .map(phoneToJid).filter(Boolean))];

export async function createGroup({ subject, description, participants, communityJid }) {
    const sock = wa.requireSock();
    if (!subject?.trim()) throw Object.assign(new Error('Group name is required'), { status: 400 });
    const jids = parsePhones(participants);
    const meta = communityJid
        ? await sock.communityCreateGroup(subject.trim(), jids, communityJid)
        : await sock.groupCreate(subject.trim(), jids);
    if (!meta?.id) throw new Error('WhatsApp did not return the new group');
    if (description?.trim()) await sock.groupUpdateDescription(meta.id, description.trim()).catch(() => { });
    await wa.refreshGroups().catch(() => { });
    return groupView(wa.groups.get(meta.id) || meta);
}

export function bulkCreateGroups({ names, description, participants, communityJid }) {
    const list = String(names || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw Object.assign(new Error('Add at least one group name'), { status: 400 });
    return startJob('create-groups', list.length, async (job) => {
        for (const subject of list) {
            try {
                const g = await createGroup({ subject, description, participants, communityJid });
                job.results.push({ target: subject, ok: true, info: g.jid });
            } catch (e) {
                job.results.push({ target: subject, ok: false, info: e.message });
            }
            job.done++; notify(job);
            if (job.done < list.length) await humanDelay(config.minDelayMs, config.maxDelayMs);
        }
    });
}

export async function createCommunity({ subject, description }) {
    const sock = wa.requireSock();
    if (!subject?.trim()) throw Object.assign(new Error('Community name is required'), { status: 400 });
    const meta = await sock.communityCreate(subject.trim(), description?.trim() || '');
    await wa.refreshGroups().catch(() => { });
    return meta ? groupView(meta) : null;
}

// ---------- settings ----------

export async function updateGroup(jid, body) {
    const sock = wa.requireSock();
    const isCommunity = !!wa.groups.get(jid)?.isCommunity;
    const fn = (g, c) => (isCommunity ? sock[c] : sock[g]).bind(sock);

    if (body.subject !== undefined) await fn('groupUpdateSubject', 'communityUpdateSubject')(jid, body.subject);
    if (body.desc !== undefined) await fn('groupUpdateDescription', 'communityUpdateDescription')(jid, body.desc || undefined);
    if (body.announce !== undefined) await fn('groupSettingUpdate', 'communitySettingUpdate')(jid, body.announce ? 'announcement' : 'not_announcement');
    if (body.restrict !== undefined) await fn('groupSettingUpdate', 'communitySettingUpdate')(jid, body.restrict ? 'locked' : 'unlocked');
    if (body.joinApprovalMode !== undefined) await fn('groupJoinApprovalMode', 'communityJoinApprovalMode')(jid, body.joinApprovalMode ? 'on' : 'off');
    if (body.memberAddMode !== undefined) await fn('groupMemberAddMode', 'communityMemberAddMode')(jid, body.memberAddMode ? 'all_member_add' : 'admin_add');
    return groupView(await wa.getGroup(jid, { fresh: true }));
}

export async function inviteLink(jid, { revoke = false } = {}) {
    const sock = wa.requireSock();
    const isCommunity = !!wa.groups.get(jid)?.isCommunity;
    const code = revoke
        ? await (isCommunity ? sock.communityRevokeInvite(jid) : sock.groupRevokeInvite(jid))
        : await (isCommunity ? sock.communityInviteCode(jid) : sock.groupInviteCode(jid));
    return code ? `https://chat.whatsapp.com/${code}` : null;
}

export async function joinByInvite(link) {
    const code = String(link || '').trim().split('/').pop();
    if (!code) throw Object.assign(new Error('Invalid invite link'), { status: 400 });
    const jid = await wa.requireSock().groupAcceptInvite(code);
    await wa.refreshGroups().catch(() => { });
    return jid;
}

export async function leave(jid) {
    const sock = wa.requireSock();
    if (wa.groups.get(jid)?.isCommunity) await sock.communityLeave(jid);
    else await sock.groupLeave(jid);
    wa.groups.delete(jid);
}

export async function linkGroup(groupJid, communityJid, unlink = false) {
    const sock = wa.requireSock();
    if (unlink) await sock.communityUnlinkGroup(groupJid, communityJid);
    else await sock.communityLinkGroup(groupJid, communityJid);
    await wa.refreshGroups().catch(() => { });
}

// ---------- bulk participants ----------

const STATUS_TEXT = {
    200: 'done',
    403: 'privacy settings block direct add',
    404: 'number is not on WhatsApp',
    408: 'recently left — WhatsApp blocks re-adding for now',
    409: 'already in the group',
    401: 'not allowed (are you admin?)',
    500: 'group is full'
};

/**
 * action: add | remove | promote | demote
 * targets: phone numbers (any format) and/or participant jids.
 * inviteFallback: on 403 for "add", DM the person the group invite link instead.
 */
export function bulkParticipants(jid, { action, targets, inviteFallback = false }) {
    if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
        throw Object.assign(new Error('Invalid action'), { status: 400 });
    }
    const meta = wa.groups.get(jid);
    if (!meta) throw Object.assign(new Error('Unknown group'), { status: 404 });
    if (!wa.amIAdmin(meta)) throw Object.assign(new Error('You must be an admin of this group'), { status: 403 });

    const raw = (Array.isArray(targets) ? targets : String(targets || '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean);
    const list = [...new Set(raw.map((t) => {
        if (t.includes('@')) return t;
        const pn = phoneToJid(t);
        if (!pn || action === 'add') return pn;
        // For remove/promote/demote use the jid the group actually knows (may be a LID).
        return wa.findParticipant(meta, pn)?.id || pn;
    }).filter(Boolean))].filter((j) => !wa.isMe(j));

    if (!list.length) throw Object.assign(new Error('No valid numbers'), { status: 400 });

    const isCommunity = !!meta.isCommunity;
    return startJob(`${action}-members`, list.length, async (job) => {
        const sock = wa.requireSock();
        let invite = null;
        for (let i = 0; i < list.length; i += CHUNK) {
            const chunk = list.slice(i, i + CHUNK);
            let res = [];
            try {
                res = await (isCommunity
                    ? sock.communityParticipantsUpdate(jid, chunk, action)
                    : sock.groupParticipantsUpdate(jid, chunk, action)) || [];
            } catch (e) {
                res = chunk.map((c) => ({ jid: c, status: 'error', error: e.message }));
            }
            for (const target of chunk) {
                const r = res.find((x) => areJidsSameUser(x.jid, target)) || res[chunk.indexOf(target)];
                const code = Number(r?.status);
                const ok = code === 200;
                let info = r?.error || STATUS_TEXT[code] || (r ? `status ${r.status}` : 'no response');
                if (action === 'add' && code === 403 && inviteFallback) {
                    try {
                        invite ||= await inviteLink(jid);
                        await wa.send(target, { text: `You're invited to join *${meta.subject}* on WhatsApp:\n${invite}` });
                        info = 'privacy block — invite link sent by DM';
                    } catch (e) {
                        info = `privacy block — invite DM failed: ${e.message}`;
                    }
                }
                job.results.push({ target: jidToPhone(target) ? `+${jidToPhone(target)}` : target, ok, info });
                job.done++;
            }
            notify(job);
            if (i + CHUNK < list.length) await humanDelay(config.minDelayMs, config.maxDelayMs);
        }
        await wa.getGroup(jid, { fresh: true }).catch(() => { });
    });
}

// ---------- jobs ----------

function startJob(type, total, fn) {
    const job = { id: db.id(), type, total, done: 0, results: [], status: 'running', startedAt: Date.now() };
    jobs.set(job.id, job);
    notify(job);
    fn(job)
        .then(() => { job.status = 'done'; })
        .catch((e) => { job.status = 'failed'; job.error = e.message; })
        .finally(() => {
            notify(job);
            setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000);
        });
    return job;
}

export const getJob = (id) => jobs.get(id);
export const listJobs = () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
