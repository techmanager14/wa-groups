// Wires WhatsApp events into the automation modules.
import { wa } from '../wa/session.js';
import { moderate } from './moderation.js';
import { autoReply, welcome } from './responders.js';
import { recordMessage, recordParticipants, snapshotAll } from './analytics.js';
import { captureFromMessage, captureGroup, captureAll } from './leads.js';
import { startScheduler } from './broadcast.js';

export function startAutomation() {
    wa.on('message', async (m) => {
        try {
            recordMessage(m);
            captureFromMessage(m);
            if (await moderate(m)) return; // moderated messages never trigger replies
            await autoReply(m);
        } catch (e) {
            console.error('[automation] message pipeline error:', e);
        }
    });

    wa.on('participants', async (ev) => {
        try {
            recordParticipants(ev);
            if (ev.action === 'add') captureGroup(wa.groups.get(ev.id), 'join');
            await welcome(ev);
        } catch (e) {
            console.error('[automation] participants pipeline error:', e);
        }
    });

    wa.on('groups', ({ reason }) => {
        if (reason === 'sync') { captureAll(); snapshotAll(); }
    });

    // Daily member-count snapshot for the growth chart.
    setInterval(() => { if (wa.status === 'connected') snapshotAll(); }, 60 * 60 * 1000);

    startScheduler();
}
