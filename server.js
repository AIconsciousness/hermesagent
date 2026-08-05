/**
 * server.js — Hermes Agent main entry point.
 *
 * Express server that:
 * 1. Receives Telegram updates via webhook (POST /webhook)
 * 2. Checks authorization on EVERY message via auth.js
 * 3. Sends user message to DeepSeek via brain.js
 * 4. Executes the determined action via tools.js
 * 5. Auto-commits file changes to GitHub
 * 6. Replies to the user on Telegram with a concise summary
 */

require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const { checkAuth } = require("./auth");
const { decideAction } = require("./brain");
const {
  executeAction,
  checkConfirmation,
  executeConfirmedAction,
  gitCommitAndPush,
} = require("./tools");

// ============================================================================
// CONFIGURATION
// ============================================================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

if (!TELEGRAM_TOKEN) {
  console.error("[server] FATAL: TELEGRAM_BOT_TOKEN is not set in environment variables.");
  process.exit(1);
}

if (!RENDER_EXTERNAL_URL) {
  console.warn("[server] WARNING: RENDER_EXTERNAL_URL is not set. Webhook setup may fail.");
}

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();
app.use(express.json());

// Health check endpoint — useful for Render and uptime monitors
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================================================
// TELEGRAM BOT (webhook mode)
// ============================================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: { port: null } });

/**
 * Main webhook handler. Every Telegram message hits this route.
 */
app.post("/webhook", async (req, res) => {
  // Always respond 200 to Telegram immediately to avoid retries
  res.sendStatus(200);

  try {
    const msg = req.body.message || req.body.edited_message;
    if (!msg || !msg.text) {
      console.log("[server] Received non-text update — ignoring.");
      return;
    }

    const chatId = msg.chat.id;
    const messageText = msg.text;

    console.log(`[server] Message from ${chatId}: "${messageText.substring(0, 100)}"`);

    // STEP 1: Authorization check — runs on EVERY message
    const auth = checkAuth(msg);
    if (!auth.authorized) {
      await bot.sendMessage(chatId, auth.reason || "⛔ Unauthorized.");
      return;
    }

    // STEP 2: Check if there's a pending confirmation for this chat
    const confirmation = checkConfirmation(chatId, messageText);

    if (confirmation) {
      if (confirmation.expired) {
        await bot.sendMessage(chatId, "⏰ Confirmation expired. Please send your request again.");
        return;
      }

      if (confirmation.declined) {
        await bot.sendMessage(chatId, "❌ Action cancelled.");
        return;
      }

      if (confirmation.confirmed) {
        // Execute the previously pending destructive action
        await bot.sendMessage(chatId, "⏳ Executing confirmed action...");
        const result = await executeConfirmedAction(confirmation.action);

        await bot.sendMessage(chatId, result.message);

        // Auto-commit after destructive action
        const gitMsg = confirmation.action.reply || messageText;
        const gitResult = await gitCommitAndPush(gitMsg);
        console.log("[server] Git result:", gitResult);
        return;
      }
    }

    // STEP 3: Send to DeepSeek brain for decision-making
    await bot.sendMessage(chatId, "🤔 Thinking...");
    let action;
    try {
      action = await decideAction(messageText);
    } catch (err) {
      console.error("[server] Brain error:", err.message);
      await bot.sendMessage(chatId, "⚠️ Sorry, the AI decision engine encountered an error. Please try again.");
      return;
    }

    // STEP 4: Execute the determined action
    const result = await executeAction(action, chatId);

    // STEP 5: Reply to user on Telegram
    await bot.sendMessage(chatId, result.message);

    // STEP 6: Auto-commit if it was a file-modifying action (create/edit)
    // For destructive actions, the commit happens after confirmation
    if (result.success && !result.needsConfirmation) {
      if (["create_file", "edit_file"].includes(action.action)) {
        const commitMsg = action.reply || messageText;
        const gitResult = await gitCommitAndPush(commitMsg);
        console.log("[server] Git result:", gitResult);
      }
    }
  } catch (err) {
    console.error("[server] Unhandled error in webhook:", err);
    // Try to notify the user if we have a chat ID
    try {
      const chatId = req.body?.message?.chat?.id || req.body?.edited_message?.chat?.id;
      if (chatId) {
        await bot.sendMessage(chatId, "⚠️ An unexpected error occurred. Check the server logs.");
      }
    } catch (_) {
      // Can't do anything more
    }
  }
});

// ============================================================================
// WEBHOOK SETUP
// ============================================================================

/**
 * Sets the Telegram webhook to point at our Render URL.
 * Called on server startup.
 */
async function setupWebhook() {
  if (!RENDER_EXTERNAL_URL) {
    console.error("[server] Cannot set webhook — RENDER_EXTERNAL_URL is not configured.");
    console.error("[server] Set it manually via Telegram Bot API or configure the env var.");
    return;
  }

  const webhookUrl = `${RENDER_EXTERNAL_URL.replace(/\/+$/, "")}/webhook`;

  try {
    await bot.setWebHook(webhookUrl);
    console.log(`[server] ✅ Webhook set to: ${webhookUrl}`);
  } catch (err) {
    console.error(`[server] ❌ Failed to set webhook:`, err.message);
    console.error("[server] You may need to set it manually.");
  }
}

// ============================================================================
// STARTUP
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[server] 🚀 Hermes Agent listening on port ${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/health`);
  console.log(`[server] Webhook: http://localhost:${PORT}/webhook`);

  // Set up the Telegram webhook
  setupWebhook();
});