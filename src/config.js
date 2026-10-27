import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const config = {
    port: num(process.env.PORT, 4100),
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
    dataDir: path.join(ROOT, 'data'),
    sessionDir: path.join(ROOT, 'data', 'session'),
    uploadDir: path.join(ROOT, 'data', 'uploads'),
    // Random pause between consecutive outgoing group messages / bulk member ops.
    // WhatsApp flags accounts that blast many groups back-to-back; keep these humane.
    minDelayMs: num(process.env.MIN_DELAY_MS, 4000),
    maxDelayMs: num(process.env.MAX_DELAY_MS, 9000),
    analyticsRetentionDays: num(process.env.ANALYTICS_RETENTION_DAYS, 90)
};
