import express from "express";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { tools, dispatchTool } from "./tools.js";
import { getAuthUrl, handleOAuthCallback, isAuthorized } from "./google.js";
import { getDueReminders, markReminderFired } from "./store.js";

const app = express();

// Pick LLM provider at boot. One of: "openai" (default), "anthropic", "openrouter", "deepseek".
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
// OpenRouter models are namespaced "<provider>/<model>" — see https://openrouter.ai/models
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5-nano";
// DeepSeek models: "deepseek-chat" (V3) or "deepseek-reasoner" (R1)
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const anthropic =
  LLM_PROVIDER === "anthropic"
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

// OpenRouter and DeepSeek both speak the OpenAI Chat Completions API — we reuse the OpenAI SDK
// and just point at a different baseURL. `openaiClient` is whichever one is active.
let openaiClient = null;
let openaiModel = OPENAI_MODEL;
if (LLM_PROVIDER === "openai") {
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  openaiModel = OPENAI_MODEL;
} else if (LLM_PROVIDER === "openrouter") {
  openaiClient = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer":
        process.env.OPENROUTER_SITE_URL || "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME || "PA Assistant",
    },
  });
  openaiModel = OPENROUTER_MODEL;
} else if (LLM_PROVIDER === "deepseek") {
  openaiClient = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1",
  });
  openaiModel = DEEPSEEK_MODEL;
}

// Long polling — no webhook, no public URL needed for messaging.
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const MAX_TOOL_TURNS = 10;
const HISTORY_LIMIT = 30;
const TIMEZONE = process.env.TIMEZONE || "America/New_York";
const USER_NAME = process.env.USER_NAME || "the user";

// OpenAI expects tools in { type: "function", function: { name, description, parameters } } form.
const openaiTools = tools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  },
}));

// Comma-separated list of Telegram user IDs allowed to talk to the bot
const AUTHORIZED_USER_IDS = new Set(
  (process.env.TELEGRAM_AUTHORIZED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Per-user conversation history (in-memory; move to store.js for persistence across restarts)
const conversations = new Map();

function localIsoNow(tz) {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  // "24" for midnight → normalize to "00"
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const asIfUtc = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}Z`,
  );
  const offsetMin = Math.round((asIfUtc.getTime() - now.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${sign}${offH}:${offM}`;
}

function systemPrompt() {
  const nowLocal = localIsoNow(TIMEZONE);
  return `You are ${USER_NAME}'s personal assistant, reachable via Telegram.

Current context:
- Timezone: ${TIMEZONE}
- Current local time: ${nowLocal}
- IMPORTANT: When producing ISO 8601 datetimes for tools, use the local time above as your reference and keep the timezone offset it shows. Do NOT mix the local wall-clock time with a UTC "Z" suffix — that will be wrong by the offset amount.

Style:
- Warm, concise, casual — like a smart friend, not a corporate bot.
- No preamble. Get to the point.
- Ask when a request is ambiguous rather than guessing.
- For destructive actions (delete event, delete task), confirm first.
- Format for Telegram: plain text is fine, simple markdown OK.

Email safety (CRITICAL):
- NEVER send an email without explicit user confirmation of recipient, subject, and body.
- Workflow: call create_email_draft first → show the user the draft (recipient, subject, full body) → wait for a clear "send" or equivalent → only then call send_email_draft.
- If unsure about the recipient's email address, use search_gmail to find prior correspondence rather than guessing.
- If the user's request is vague (tone, length, timing), draft a first pass and let them iterate rather than sending immediately.
- A response like "sounds good" is NOT confirmation to send unless you had just asked whether to send this exact draft.

Email quality:
- Write drafts in clear, natural, grammatically correct English (or the target language) regardless of how the user phrased the request. Fix grammar, articles, prepositions, and word order silently — don't mirror the user's shorthand.
- Match tone to the recipient: professional for work, warm for friends, polite and direct for vendors/services. Avoid stilted formality ("I am writing to inform you...") — aim for how a well-spoken, thoughtful person actually writes.
- Structure: brief greeting → context/purpose in a line or two → the specific ask or info → short sign-off. Keep it concise; cut anything that isn't earning its place.
- Always sign every email with the user's name (${USER_NAME}). Match the sign-off phrase to the tone: "Thanks, ${USER_NAME}" or "Best, ${USER_NAME}" for professional; just "${USER_NAME}" or "— ${USER_NAME}" for casual; "Love, ${USER_NAME}" for family and close friends.
- Proofread every draft before you present it: no typos, no missing articles, no awkward phrasing.

Tools:
- When she gives vague times ("tomorrow at 3", "next Wed morning"), resolve them to concrete ISO 8601 datetimes in her timezone before calling calendar tools.
- For "what's on today", use the local day boundaries (start of day → end of day) in her timezone.
- After using tools, summarize the result in a friendly line — don't dump raw JSON.

Reminders:
- "Remind me to X at Y" / "in Z minutes" → schedule_reminder with a concrete ISO 8601 fire_at (include the timezone offset). The message should be the nudge itself, short and imperative ("Call Sam", not "Reminder: to call Sam").
- Use reminders for time-based nudges over Telegram. Use add_task for open-ended to-dos with no fire time, and create_event for things that need a calendar block.`;
}

export async function chat(userKey, userText, { userId } = {}) {
  const history = conversations.get(userKey) ?? [];
  const toolContext = { userId: userId ?? userKey };

  const finalText =
    LLM_PROVIDER === "anthropic"
      ? await chatAnthropic(history, userText, toolContext)
      : await chatOpenAI(history, userText, toolContext);

  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
  conversations.set(userKey, history);

  return (
    finalText || "(no response — model may have hit the tool-use turn cap)"
  );
}

async function chatAnthropic(history, userText, toolContext) {
  history.push({ role: "user", content: userText });

  let finalText = "";
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt(),
      tools,
      messages: history,
    });

    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(
            await dispatchTool(tu.name, tu.input, toolContext),
          ),
        })),
      );
      history.push({ role: "user", content: toolResults });
      continue;
    }

    finalText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    break;
  }
  return finalText;
}

async function chatOpenAI(history, userText, toolContext) {
  history.push({ role: "user", content: userText });

  let finalText = "";
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await openaiClient.chat.completions.create({
      model: openaiModel,
      messages: [{ role: "system", content: systemPrompt() }, ...history],
      tools: openaiTools,
    });

    const msg = response.choices[0].message;
    // Persist the assistant turn exactly as OpenAI returned it (tool_calls included).
    history.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });

    if (msg.tool_calls?.length) {
      const results = await Promise.all(
        msg.tool_calls.map(async (tc) => {
          let args = {};
          try {
            args = tc.function.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch (err) {
            return {
              tool_call_id: tc.id,
              content: JSON.stringify({
                error: `Invalid JSON arguments: ${err.message}`,
              }),
            };
          }
          const result = await dispatchTool(
            tc.function.name,
            args,
            toolContext,
          );
          return { tool_call_id: tc.id, content: JSON.stringify(result) };
        }),
      );
      for (const r of results) {
        history.push({
          role: "tool",
          tool_call_id: r.tool_call_id,
          content: r.content,
        });
      }
      continue;
    }

    finalText = (msg.content ?? "").trim();
    break;
  }
  return finalText;
}

export async function sendTelegram(chatId, text) {
  return bot.sendMessage(chatId, text);
}

// --- Incoming Telegram messages ---
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text?.trim();
  if (!text) return;

  // Print user ID so you can whitelist yourself after the first message
  console.log(
    `[msg] from ${userId} (${msg.from.first_name || "unknown"}): ${text}`,
  );

  if (AUTHORIZED_USER_IDS.size > 0 && !AUTHORIZED_USER_IDS.has(userId)) {
    console.warn(`Rejected message from unauthorized user ${userId}`);
    await bot.sendMessage(
      chatId,
      `Sorry, this assistant is private. Your Telegram user ID is ${userId} if the owner needs it.`,
    );
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await chat(userId, text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error("Chat failed:", err);
    await sendTelegram(chatId, `⚠️ Something broke: ${err.message}`).catch(
      () => {},
    );
  }
});

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.message);
});

// --- Google OAuth (one-time setup) ---
app.get("/oauth/start", (req, res) => res.redirect(getAuthUrl()));
app.get("/oauth/callback", handleOAuthCallback);

// --- Health check ---
app.get("/", (req, res) => {
  res.send(
    `Assistant running. Google authorized: ${isAuthorized() ? "yes" : "no — visit /oauth/start"}`,
  );
});

// --- Morning brief (cron) ---
const briefSchedule = process.env.MORNING_BRIEF_CRON || "0 8 * * 1-5";
const morningTarget = [...AUTHORIZED_USER_IDS][0]; // send to the first authorized user

if (morningTarget) {
  cron.schedule(
    briefSchedule,
    async () => {
      console.log("Running morning brief...");
      try {
        const brief = await chat(
          `${morningTarget}::cron`,
          `It's morning. Give me a short brief for today: what's on my calendar and my open tasks. Under 6 short lines. No preamble.`,
        );
        await sendTelegram(morningTarget, `🌅 Morning brief\n\n${brief}`);
      } catch (err) {
        console.error("Morning brief failed:", err);
      }
    },
    { timezone: TIMEZONE },
  );
  console.log(
    `Morning brief scheduled: "${briefSchedule}" (${TIMEZONE}) → user ${morningTarget}`,
  );
} else {
  console.log(
    "Morning brief disabled (set TELEGRAM_AUTHORIZED_USER_IDS to enable)",
  );
}

// --- Reminder poller ---
const REMINDER_POLL_MS = Number(process.env.REMINDER_POLL_MS) || 30_000;

async function fireDueReminders() {
  const due = getDueReminders(new Date().toISOString());
  for (const r of due) {
    try {
      await sendTelegram(r.user_id, `⏰ ${r.message}`);
      markReminderFired(r.id);
    } catch (err) {
      console.error(`Failed to send reminder ${r.id}:`, err.message);
      // Leave fired=0 so we retry on the next tick.
    }
  }
}

setInterval(() => {
  fireDueReminders().catch((err) =>
    console.error("Reminder poll failed:", err),
  );
}, REMINDER_POLL_MS);
console.log(`Reminder poller running every ${REMINDER_POLL_MS}ms`);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Assistant listening on :${PORT}`);
  console.log(
    `Google authorized: ${isAuthorized() ? "yes" : "no — visit http://localhost:" + PORT + "/oauth/start"}`,
  );
  console.log(`Telegram bot polling for messages...`);
});
