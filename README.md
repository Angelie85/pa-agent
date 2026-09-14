# Personal Assistant (Telegram)

A private Telegram bot that acts as your personal assistant — powered by Claude, with Google Calendar, Gmail, and a simple task list. Text it "what's on today?", "draft an email to Sam about Thursday", "remind me to book flights", and it handles it.

Also sends a morning brief every weekday at 8am.

## How it works

```
Telegram → long polling → Express server → Claude (tool use)
                                               ↓
                               Google Calendar + Gmail APIs + SQLite tasks
```

Claude's tool use is the core mechanism: you define a schema of capabilities (`list_events`, `create_event`, `search_gmail`, `create_email_draft`, etc.), Claude decides which tools to call based on your message, and the server dispatches the calls. Tool results route back to Claude to compose a natural-language reply.

## Available tools

| Tool | What it does |
|------|-------------|
| `list_events` | Show calendar events in a time range |
| `create_event` | Add an event to the primary calendar |
| `delete_event` | Remove a calendar event (confirms first) |
| `add_task` | Add an item to the to-do list |
| `list_tasks` | Show open (or all) tasks |
| `complete_task` | Mark a task done |
| `delete_task` | Remove a task (confirms first) |
| `search_gmail` | Search inbox with Gmail query syntax |
| `read_email` | Fetch full body of a specific email |
| `list_recent_emails` | Show recent inbox emails |
| `create_email_draft` | Create a draft (never sends without confirmation) |
| `send_email_draft` | Send a draft after explicit user confirmation |

## Setup

You need accounts for **Anthropic**, **Telegram**, and **Google Cloud**. Total setup is ~30 min the first time.

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Anthropic API key

Go to https://console.anthropic.com/ → API keys → Create key. Paste into `.env` as `ANTHROPIC_API_KEY`.

### 3. Telegram bot

- Open Telegram and message **@BotFather**
- `/newbot` → choose a name and username
- Copy the **Bot Token** into `.env` as `TELEGRAM_BOT_TOKEN`
- Send yourself any message to the bot to learn your **Telegram user ID** — it prints in the server logs
- Add your user ID to `TELEGRAM_AUTHORIZED_USER_IDS` (comma-separated for multiple users)

The bot uses long polling — no public URL required for local dev.

### 4. Google Cloud project

- Go to https://console.cloud.google.com/ → create or select a project
- Enable **Google Calendar API** and **Gmail API** (APIs & Services → Library)
- **OAuth consent screen** → User Type "External", add yourself as a test user, add scopes:
  - `.../auth/calendar`
  - `.../auth/gmail.modify`
- **Credentials** → Create OAuth 2.0 Client ID → Web application
- Add authorized redirect URI: `http://localhost:3000/oauth/callback`
- Copy Client ID + Secret into `.env`

### 5. Run + authorize Google

```bash
npm run dev
```

Then open `http://localhost:3000/oauth/start` in a browser and complete Google's consent flow. Tokens are saved to SQLite and auto-refreshed; you won't need to repeat this unless you revoke access.

### 6. Try it

Message your bot on Telegram:

```
what's on today?
am I free Thursday afternoon?
add coffee with Sam Friday at 10am
remind me to book flights
what's on my list?
mark task 2 done
what's new in my inbox?
search my email for invoices from Acme
draft an email to sam@example.com about rescheduling Thursday
```

## Configuration (`.env`)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_AUTHORIZED_USER_IDS` | Comma-separated Telegram user IDs allowed to use the bot |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL (default: `http://localhost:3000/oauth/callback`) |
| `TIMEZONE` | Your timezone (default: `America/New_York`) |
| `USER_NAME` | Your name — used in the system prompt and email sign-offs |
| `MORNING_BRIEF_CRON` | Cron schedule for morning brief (default: `0 8 * * 1-5`) |
| `PORT` | HTTP server port (default: `3000`) |
| `DATA_DIR` | SQLite data directory (default: `data`) |

## Extending

**Add a new tool** — edit `src/tools.js`:
1. Add an entry to the `tools` array (name, description, `input_schema`).
2. Add a matching handler to the `handlers` object.

Claude picks it up immediately — no changes to `index.js` needed.

**Ideas:**
- `get_weather` — enrich the morning brief with today's forecast
- `create_reminder` (cron + Telegram send) — "text me at 6pm to leave"
- `search_notes` (Notion / Obsidian API) — "what did I write about X?"
- `expense` (Google Sheets append) — "log $47 lunch to expenses"
- `read_google_doc` — summarize or query a specific document

**Deploy** — see [DEPLOY.md](DEPLOY.md). The app is designed for Render (includes `render.yaml`) but runs on any Node.js host with a persistent volume for `data/`.

**Persistence** — conversation history is in-memory and resets on restart. Move `conversations` from a `Map` to a SQLite table in `store.js` if you want it to survive restarts.

## Gotchas

- **Google OAuth in test mode** limits refresh tokens to 7 days. For personal use that's fine — re-run `/oauth/start` weekly, or submit your app for Google verification.
- **Authorization whitelist** — `TELEGRAM_AUTHORIZED_USER_IDS` gates access. Leave it empty during initial setup to see your user ID in the logs, then add it and restart.
- **Model choice** — `claude-sonnet-5` is the default (~$3/$15 per M tokens). For lower cost try `claude-haiku-4-5-20251001` (~$0.80/$4). Change `MODEL` in `src/index.js`.
- **Cost estimate** — normal daily use (~50 messages) runs ~$0.50–$2/mo on Sonnet 5.
- **Email safety** — the assistant always creates a draft and shows it to you before sending. A "sounds good" reply does not trigger a send; you must explicitly say "send it".
- **Timezones** — everything runs in `TIMEZONE` from `.env`. Update it if you travel.

## File layout

```
src/
  index.js    — Express server, Telegram bot, Claude agentic loop, cron
  tools.js    — Tool schemas + handlers (add new capabilities here)
  google.js   — OAuth client, Calendar and Gmail API wrappers
  store.js    — SQLite: tasks table + key/value store for tokens
data/
  assistant.db — created on first run (git-ignored)
doc/
  architecture.md — system architecture and design decisions
render.yaml   — Render deployment blueprint
DEPLOY.md     — deployment guide
```

Under 500 lines of JS total.
