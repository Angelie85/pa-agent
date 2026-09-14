# CLAUDE.md

## Project overview

A private Telegram bot that acts as a personal assistant. Claude is the reasoning layer; it uses tool use to interact with Google Calendar, Gmail, and a SQLite task list. The entire server is under 500 lines of plain JavaScript (ESM, Node 20+).

## Key files

| File | Role |
|------|------|
| `src/index.js` | Entry point: Express server, Telegram long-poll bot, Claude agentic loop, morning-brief cron |
| `src/tools.js` | All tool schemas (sent to Claude) and their handler implementations |
| `src/google.js` | Google OAuth client, auto-token refresh, Calendar and Gmail API wrappers |
| `src/store.js` | SQLite via `better-sqlite3`: `tasks` table + `kv` store for OAuth tokens |
| `render.yaml` | Render deployment blueprint (web service + persistent disk) |
| `.env.example` | All supported environment variables with descriptions |

## Architecture at a glance

```
Telegram ─long-poll→ bot.on("message") → chat(userId, text)
                                              │
                                         anthropic.messages.create()
                                              │
                                    ┌─── stop_reason: "tool_use" ───┐
                                    │                               │
                              dispatchTool()              (loop up to 10 turns)
                                    │
                       handlers in tools.js
                       (Calendar, Gmail, SQLite)
                                    │
                               tool results ──→ next Claude turn
                                                      │
                                              stop_reason: "end_turn"
                                                      │
                                             bot.sendMessage()
```

## How to add a tool

1. Add a schema entry to the `tools` array in `src/tools.js` — name, description, and `input_schema`.
2. Add a matching async function to the `handlers` object in the same file.

That's all. Claude will start using it on the next message.

## Environment variables

All config lives in `.env` (copy from `.env.example`). Required at runtime:
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_AUTHORIZED_USER_IDS` (comma-separated)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`

Optional (have defaults):
- `TIMEZONE` — default `America/New_York`
- `USER_NAME` — used in system prompt and email sign-offs
- `MORNING_BRIEF_CRON` — cron expression, default `0 8 * * 1-5`
- `PORT` — default `3000`
- `DATA_DIR` — SQLite directory, default `data`

## Running locally

```bash
npm install
cp .env.example .env   # fill in your keys
npm run dev            # node --watch --env-file=.env src/index.js
```

Then visit `http://localhost:3000/oauth/start` to authorize Google (one-time).

## Email safety invariant

The assistant **never sends email without explicit user confirmation**. The enforced workflow is:
1. `create_email_draft` → shows the user recipient, subject, and body
2. User says "send" (or equivalent)
3. `send_email_draft` → sends

This is enforced in both the system prompt and the tool descriptions. Do not change this without understanding the implications.

## Conversation history

History is per-user, in-memory (`Map` keyed by Telegram user ID). Capped at 30 messages (configurable via `HISTORY_LIMIT`). It resets on server restart. Move `conversations` to a SQLite table in `store.js` for persistence across restarts.

## Model

`claude-sonnet-5` by default. Change `MODEL` in `src/index.js`. Haiku is cheaper for high-volume use; Opus gives better reasoning on complex scheduling tasks.

## Deployment

Render is the target platform — `render.yaml` provisions the web service and a 1 GB persistent disk for SQLite. See `DEPLOY.md` for step-by-step instructions. The app also runs on any host with Node 20+ and a writable `DATA_DIR`.
