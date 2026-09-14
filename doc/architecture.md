# Architecture

## Overview

The personal assistant is a single Node.js process that connects four external systems — Telegram, Anthropic Claude, Google APIs (Calendar + Gmail), and a local SQLite database — through a thin Express HTTP server and a Telegram long-polling client.

The design is intentionally minimal: under 500 lines of JavaScript across four source files, no framework abstractions, no build step.

## Component diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        User (Telegram)                      │
└─────────────────────────────┬───────────────────────────────┘
                              │ message
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    src/index.js                             │
│                                                             │
│  TelegramBot (long polling)   Express HTTP server           │
│  ┌──────────────────────┐     ┌──────────────────────────┐  │
│  │ bot.on("message")    │     │ GET /oauth/start          │  │
│  │ → chat(userId, text) │     │ GET /oauth/callback       │  │
│  └──────────┬───────────┘     │ GET /  (health check)    │  │
│             │                 └──────────────────────────┘  │
│  node-cron  │                                               │
│  ┌──────────┴───────────┐                                   │
│  │ Morning brief (8am)  │                                   │
│  └──────────┬───────────┘                                   │
│             │                                               │
│        chat(userId, text)                                   │
│             │                                               │
└─────────────┼───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│             Claude agentic loop (src/index.js)              │
│                                                             │
│  anthropic.messages.create({ model, system, tools, msgs })  │
│             │                                               │
│    ┌────────┴────────┐                                      │
│    │ stop_reason?    │                                      │
│    ├─────────────────┤                                      │
│    │ "tool_use"      │──→ dispatchTool() ──→ tool result    │
│    │                 │         │            appended to     │
│    │  (up to 10      │◄────────┘            messages[]      │
│    │   turns)        │                                      │
│    ├─────────────────┤                                      │
│    │ "end_turn"      │──→ extract text → sendTelegram()     │
│    └─────────────────┘                                      │
└─────────────┬───────────────────────────────────────────────┘
              │ dispatchTool()
              ▼
┌─────────────────────────────────────────────────────────────┐
│                 src/tools.js                                │
│                                                             │
│  handlers:                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ Calendar tools   │  │ Gmail tools      │                 │
│  │ list_events      │  │ search_gmail     │                 │
│  │ create_event     │  │ read_email       │                 │
│  │ delete_event     │  │ list_recent_... │                 │
│  └────────┬─────────┘  │ create_email_.. │                 │
│           │            │ send_email_...  │                 │
│           │            └────────┬────────┘                 │
└───────────┼─────────────────────┼───────────────────────────┘
            │                     │
            ▼                     ▼
┌───────────────────┐   ┌─────────────────────────────────────┐
│   src/store.js    │   │         src/google.js               │
│                   │   │                                     │
│  better-sqlite3   │   │  getOAuthClient()                   │
│                   │   │  → google.auth.OAuth2               │
│  tables:          │   │  → auto-refresh on token expiry     │
│  - tasks          │   │                                     │
│    (id, title,    │   │  calendar() → googleapis Calendar   │
│     done,         │   │  gmail()    → googleapis Gmail      │
│     created_at)   │   │                                     │
│  - kv             │   │  OAuth tokens persisted in kv store │
│    (key, value)   │   │  (key: "google_tokens")             │
│                   │   │                                     │
│  data/            │   └──────────────┬──────────────────────┘
│  assistant.db     │                  │
└───────────────────┘                  ▼
                              Google APIs (HTTPS)
                              ┌──────────────────┐
                              │ Calendar API v3  │
                              │ Gmail API v1     │
                              └──────────────────┘
```

## Request lifecycle

### Inbound message

1. Telegram delivers a message via long polling to `bot.on("message")` in `src/index.js`.
2. The handler checks the sender's user ID against `TELEGRAM_AUTHORIZED_USER_IDS`. Unauthorized senders get a rejection message with their user ID.
3. `chat(userId, text)` is called. It appends the message to the user's conversation history (in-memory `Map`), then enters the Claude agentic loop.
4. The loop calls `anthropic.messages.create()` with the full message history, the current system prompt, and the tool schemas from `src/tools.js`.
5. If Claude returns `stop_reason: "tool_use"`, all requested tool calls are dispatched in parallel via `dispatchTool()`, results are appended to the history as a `tool_result` block, and the loop continues.
6. When Claude returns `stop_reason: "end_turn"`, the final text is extracted and sent back to the user via `bot.sendMessage()`.
7. History is trimmed to the last 30 messages (`HISTORY_LIMIT`) to bound memory and token usage.

### Morning brief (cron)

`node-cron` fires on `MORNING_BRIEF_CRON` (default: `0 8 * * 1-5`). It calls `chat()` with a fixed prompt asking for today's calendar and open tasks, then sends the result to the first authorized Telegram user.

### Google OAuth (one-time setup)

`GET /oauth/start` redirects to Google's consent screen. After the user approves, Google redirects to `GET /oauth/callback`, which exchanges the authorization code for tokens and persists them to the `kv` SQLite table under key `google_tokens`. On every subsequent API call, `getOAuthClient()` loads the tokens from SQLite and the Google SDK refreshes them automatically when they expire.

## Data model

### `tasks` table

```sql
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### `kv` table

Generic key-value store. Currently used for one key: `google_tokens` (JSON-serialized OAuth token object).

```sql
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## Security boundaries

- **Authorization** — only Telegram user IDs listed in `TELEGRAM_AUTHORIZED_USER_IDS` can interact with the bot. The check happens before any Claude or tool call.
- **Email safety** — the system prompt and tool descriptions explicitly forbid sending email without a two-step confirmation: `create_email_draft` first, then explicit user confirmation, then `send_email_draft`. Claude is instructed to treat "sounds good" as insufficient for send confirmation.
- **Secrets** — API keys and OAuth credentials are loaded from environment variables, never hardcoded. The `.env` file and `data/` directory are git-ignored.
- **No inbound webhook** — Telegram long polling means the server does not need a public HTTPS URL and is not exposed to arbitrary inbound HTTP traffic (only Google OAuth callbacks require the HTTP server to be reachable).

## Conversation state

Conversation history is stored per-user in a `Map<userId, Message[]>` in process memory. This means:

- History is shared across all messages from a given Telegram user ID.
- History resets on server restart.
- The cron morning brief uses a synthetic user key (`userId + "::cron"`) so its history is isolated from the user's interactive conversation.

To persist history across restarts, add a `conversations` table to `store.js` and replace the `Map` reads/writes in `chat()`.

## Deployment

The application targets **Render** (`render.yaml`). Key deployment choices:

| Decision | Rationale |
|----------|-----------|
| Persistent disk for SQLite | Tasks and Google tokens must survive deploys |
| Long polling (not webhook) | No public URL needed for Telegram; simpler setup |
| Single Node.js process | Fits a $7/mo Render starter instance; no queue or worker needed |
| WAL journal mode | Allows concurrent SQLite reads without blocking writes |

The app also deploys on any platform with Node 20+, a writable `DATA_DIR`, and outbound HTTPS access. No Redis, no message queue, no external session store required.

## Adding capabilities

To add a new tool:

1. Add a schema to the `tools` array in `src/tools.js`:
   ```js
   {
     name: 'my_tool',
     description: 'What it does and when Claude should call it.',
     input_schema: {
       type: 'object',
       properties: { /* ... */ },
       required: ['required_field'],
     },
   }
   ```

2. Add a handler to the `handlers` object in the same file:
   ```js
   async my_tool({ required_field }) {
     // do the thing
     return { result: '...' };
   }
   ```

`dispatchTool()` routes by name automatically. No changes to `index.js` needed.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API client |
| `node-telegram-bot-api` | Telegram Bot API (long polling) |
| `googleapis` | Google Calendar and Gmail API clients |
| `better-sqlite3` | Synchronous SQLite bindings |
| `express` | HTTP server for OAuth callback and health check |
| `node-cron` | Cron scheduler for morning brief |
