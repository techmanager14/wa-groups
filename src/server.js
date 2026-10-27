import express from 'express';
import http from 'http';
import path from 'path';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { config, ROOT } from './config.js';
import { db } from './db.js';
import { wa } from './wa/session.js';
import { onJobChange } from './wa/manage.js';
import { startAutomation } from './automation/index.js';
import { onBroadcastChange } from './automation/broadcast.js';
import { chatService } from './chat/chat.service.js';
import api, { AUTH_COOKIE, authToken } from './routes/api.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/api', api);
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || err.output?.statusCode || 500;
    if (status >= 500) console.error('[http]', req.method, req.path, err);
    res.status(status).json({ error: err.message || 'Server error' });
});

// ---------- realtime ----------

io.use((socket, next) => {
    const cookie = socket.handshake.headers.cookie || '';
    const token = cookie.split(';').map((c) => c.trim().split('=')).find(([k]) => k === AUTH_COOKIE)?.[1];
    return token === authToken() ? next() : next(new Error('unauthorized'));
});
io.on('connection', (s) => s.emit('wa:status', wa.publicState()));

wa.on('status', (state) => io.emit('wa:status', state));
let groupsTimer = null;
wa.on('groups', () => {
    // Debounce: participant storms can fire dozens of updates per second.
    clearTimeout(groupsTimer);
    groupsTimer = setTimeout(() => io.emit('groups:changed'), 1000);
});
onJobChange((job) => io.emit('job', job));
onBroadcastChange((b) => io.emit('broadcast', b));
chatService.on('message', (msg) => io.emit('chat:message', msg));
chatService.on('read', (ev) => io.emit('chat:read', ev));

// ---------- boot ----------

startAutomation();

server.listen(config.port, () => {
    console.log(`\n  WA-Groups running →  http://localhost:${config.port}\n`);
    if (config.adminPassword === 'admin123') {
        console.warn('  ⚠  Using default password "admin123". Set ADMIN_PASSWORD in .env\n');
    }
    if (wa.hasSession()) wa.connect().catch((e) => console.error('[wa] auto-connect failed:', e.message));
});

const shutdown = () => {
    try { db.flushNow(); } catch { }
    wa.teardown();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
