import express from "express";
import cron from "node-cron";
import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import { tools, dispatchTool } from "./tools.js";
import { getAuthUrl, handleOAuthCallback, isAuthorized } from "./google.js";

const app = express();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Long polling — no webhook, no public URL needed for messaging.
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const MODEL = "claude-sonnet-5";
const MAX_TOOL_TURNS = 10;
const HISTORY_LIMIT = 30;
const TIMEZONE = process.env.TIMEZONE || "America/New_York";
const USER_NAME = process.env.USER_NAME || "the user";

// Comma-separated list of Telegram user IDs allowed to talk to the bot
const AUTHORIZED_USER_IDS = new Set(
  (process.env.TELEGRAM_AUTHORIZED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Per-user conversation history (in-memory; move to store.js for persistence across restarts)
const conversations = new Map();

function systemPrompt() {
  const now = new Date();
  return `You are ${USER_NAME}'s personal assistant, reachable via Telegram.

Current context:
- Timezone: ${TIMEZONE}
- Now: ${now.toISOString()} (${now.toLocaleString("en-US", { timeZone: TIMEZONE })})

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
- After using tools, summarize the result in a friendly line — don't dump raw JSON.`;
}

export async function chat(userKey, userText) {
  const history = conversations.get(userKey) ?? [];
  history.push({ role: "user", content: userText });

  let finalText = "";
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
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
          content: JSON.stringify(await dispatchTool(tu.name, tu.input)),
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

  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
  conversations.set(userKey, history);

  return (
    finalText || "(no response — Claude may have hit the tool-use turn cap)"
  );
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Assistant listening on :${PORT}`);
  console.log(
    `Google authorized: ${isAuthorized() ? "yes" : "no — visit http://localhost:" + PORT + "/oauth/start"}`,
  );
  console.log(`Telegram bot polling for messages...`);
});
