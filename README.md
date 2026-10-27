# WA-Groups — WhatsApp Groups & Communities Automation

A lightweight, standalone web app and automation engine for **WhatsApp Groups & Communities**, powered by Baileys (QR-code Linked Devices login).

---

## Features

- 📱 **QR Code Login**: Pair seamlessly via WhatsApp Linked Devices (no official Cloud API limitations).
- 👥 **Group Management**: List, inspect, create, join via invite link, and update group settings (announcement mode, member add restrictions, admin approvals).
- 🏘️ **WhatsApp Communities**: Full support for Community creation, linking/unlinking groups, and sending to Announcement channels.
- 💬 **Dynamic Variable Messaging**: Send or broadcast messages with auto-resolved variables per group:
  - `{group}` / `{group_name}` — Group title
  - `{size}` / `{count}` — Member count
  - `{admins_count}` — Number of admins
  - `{desc}` — Group description
  - `{date}` / `{time}` / `{day}` — Timestamp information
  - `{custom_var}` — User-defined custom variables (e.g., `{coupon}`, `{link}`)
- 📣 **Broadcasts & Scheduler**: Broadcast to multiple selected groups with randomized human-like delays (4–9s) to protect numbers from rate limits and bans.
- 🤖 **Keyword Auto-Replies**: Rule-based group chat bot (contains, exact, starts-with, regex) with per-group cooldowns and `@user` mentions.
- 🛡️ **Group Moderation**: Anti-link filtering (with domain whitelist), anti-spam/flood detection, and banned words filter (action: delete, warn, or remove).
- 👋 **Welcome & Goodbye**: Automated arrival and departure messages tagging new members.
- 📇 **Lead Capture**: Auto-syncs group members and message senders into a contacts database with one-click CSV export.
- 📊 **Analytics**: Message volume, join/leave ratios, net group growth, and top active members charts.

---

## Quick Start

### 1. Requirements
- Node.js 20+

### 2. Install & Run
```bash
git clone <repo-url>
cd wa-groups
npm install
npm start
```

Open [http://localhost:4100](http://localhost:4100) in your browser.

- Default password: `admin123` (configure in `.env` via `ADMIN_PASSWORD`)

---

## Configuration

Copy `.env.example` to `.env`:
```env
PORT=4100
ADMIN_PASSWORD=your_password
MIN_DELAY_MS=4000
MAX_DELAY_MS=9000
ANALYTICS_RETENTION_DAYS=90
```

---

## Security Note

All session credentials and lead data are stored locally in the `data/` directory and are excluded from git version control.
