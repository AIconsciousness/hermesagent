/**
 * auth.js — Authorization middleware for Hermes agent.
 * Ensures ONLY the configured Telegram user can interact with the bot.
 * This check runs on EVERY incoming message.
 */

const AUTHORIZED_ID = process.env.AUTHORIZED_TELEGRAM_ID;

/**
 * Checks whether the sender of a Telegram message is authorized.
 * @param {object} msg — The Telegram message object from the update.
 * @returns {{ authorized: boolean, reason?: string }}
 */
function checkAuth(msg) {
  if (!msg || !msg.from) {
    return { authorized: false, reason: "No sender information found." };
  }

  const senderId = String(msg.from.id);

  // Authorized ID may be stored as a comma-separated list for multiple users
  const allowedIds = (AUTHORIZED_ID || "").split(",").map(id => id.trim());

  if (!allowedIds.length || !allowedIds[0]) {
    console.error("[auth] AUTHORIZED_TELEGRAM_ID is not set in environment!");
    return { authorized: false, reason: "Server misconfiguration — authorized ID not set." };
  }

  if (!allowedIds.includes(senderId)) {
    console.warn(`[auth] Unauthorized access attempt from Telegram ID: ${senderId}`);
    return { authorized: false, reason: "Unauthorized" };
  }

  return { authorized: true };
}

module.exports = { checkAuth };