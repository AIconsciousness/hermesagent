/**
 * memory.js — Persistent memory for Hermes.
 *
 * Stores conversation history and project state per chat in a JSON file inside
 * /workspace so it:
 *   - survives Render restarts (the file lives on disk)
 *   - survives Render redeploys (it's committed to GitHub alongside file changes)
 *
 * This is what lets the bot "remember" a project across days — e.g. building a
 * Zomato clone incrementally, the bot recalls what was built yesterday.
 */

const fs = require("fs");
const path = require("path");

// Memory file lives in /workspace so it rides along with the git auto-commit
const MEMORY_FILE = path.resolve(__dirname, "workspace", ".hermes-memory.json");

// Per-chat memory: { [chatId]: { history: [{role,content}], project: {...} } }
const MAX_HISTORY = 40; // keep the last 40 messages (20 exchanges) per chat

/**
 * Loads the memory file from disk. Returns {} if missing or corrupted.
 */
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
      return data && typeof data === "object" ? data : {};
    }
  } catch (e) {
    console.error("[memory] Failed to load memory:", e.message);
  }
  return {};
}

/**
 * Writes the memory object to disk.
 */
function saveMemory(memory) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf8");
  } catch (e) {
    console.error("[memory] Failed to save memory:", e.message);
  }
}

/**
 * Returns (and lazily creates) the memory entry for a chat.
 */
function getChatMemory(memory, chatId) {
  const key = String(chatId);
  if (!memory[key]) {
    memory[key] = { history: [], project: { name: null, description: "", files: [] } };
  }
  return memory[key];
}

/**
 * Appends a user/assistant exchange to the chat's history, capped at MAX_HISTORY.
 */
function rememberExchange(chatMemory, userMessage, assistantReply) {
  chatMemory.history.push({ role: "user", content: userMessage });
  chatMemory.history.push({ role: "assistant", content: assistantReply });
  while (chatMemory.history.length > MAX_HISTORY) {
    chatMemory.history.shift();
  }
}

module.exports = {
  loadMemory,
  saveMemory,
  getChatMemory,
  rememberExchange,
  MAX_HISTORY,
  MEMORY_FILE,
};
