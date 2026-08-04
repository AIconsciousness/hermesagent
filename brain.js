/**
 * brain.js — The decision-making layer of Hermes.
 * Sends the user's message to DeepSeek API and parses the structured
 * JSON response to determine which action to execute.
 *
 * DeepSeek API endpoint (OpenAI-compatible):
 *   POST https://api.deepseek.com/chat/completions
 */

const https = require("https");

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

/**
 * The system prompt tells DeepSeek exactly how to respond.
 * It MUST reply in strict JSON matching one of the defined action types.
 * All file paths MUST be relative and MUST be inside /workspace.
 */
const SYSTEM_PROMPT = `You are Hermes, a Telegram-controlled agentic assistant. Your responses must be STRICT JSON — no markdown, no extra text.

You have access to these actions:

1. Chat response (no side effects):
{ "action": "chat", "reply": "Your message to the user" }

2. Create a new file inside /workspace:
{ "action": "create_file", "path": "relative/path/in/workspace", "content": "full file content", "reply": "What to tell the user" }

3. Edit an existing file inside /workspace (find and replace first occurrence):
{ "action": "edit_file", "path": "relative/path/in/workspace", "find": "exact text to find", "replace": "replacement text", "reply": "What to tell the user" }

4. Delete a file inside /workspace:
{ "action": "delete_file", "path": "relative/path/in/workspace", "reply": "What to tell the user" }

5. Run a safe shell command (only npm install, npm test, node <file>, git status):
{ "action": "run_command", "command": "allowed command", "reply": "What to tell the user" }

RULES:
- All "path" values MUST be relative — do NOT use absolute paths, do NOT use ../ to escape.
- Never suggest paths outside /workspace.
- For edit_file, the "find" must be an exact substring present in the file.
- For run_command, only use: npm install, npm test, node <workspace-file>, git status.
- Keep "reply" concise — it will be sent directly to the user on Telegram.
- Always include a "reply" field with every action.`;

/**
 * Sends the user's message and conversation history to DeepSeek
 * and returns the parsed JSON action object.
 *
 * @param {string} userMessage — The text the user sent on Telegram.
 * @param {Array<{role: string, content: string}>} history — Optional conversation history.
 * @returns {Promise<object>} — The parsed action object.
 */
async function decideAction(userMessage, history = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  const requestBody = JSON.stringify({
    model: "deepseek-chat",
    messages: messages,
    temperature: 0.3,
    max_tokens: 4096,
  });

  const options = {
    hostname: "api.deepseek.com",
    path: "/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Length": Buffer.byteLength(requestBody),
    },
    timeout: 60000, // 60 second timeout
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.choices || !parsed.choices[0] || !parsed.choices[0].message) {
            console.error("[brain] Unexpected DeepSeek response structure:", data);
            reject(new Error("Invalid response structure from DeepSeek API"));
            return;
          }
          const content = parsed.choices[0].message.content.trim();

          // DeepSeek might wrap JSON in markdown code fences — strip them
          let jsonStr = content;
          if (jsonStr.startsWith("```json")) {
            jsonStr = jsonStr.slice(7);
          } else if (jsonStr.startsWith("```")) {
            jsonStr = jsonStr.slice(3);
          }
          if (jsonStr.endsWith("```")) {
            jsonStr = jsonStr.slice(0, -3);
          }
          jsonStr = jsonStr.trim();

          console.log("[brain] DeepSeek raw response:", content);
          console.log("[brain] Cleaned JSON:", jsonStr);

          const action = JSON.parse(jsonStr);
          resolve(action);
        } catch (err) {
          console.error("[brain] Failed to parse DeepSeek response:", err.message);
          console.error("[brain] Raw data received:", data);
          // Return a fallback chat action so the user gets something
          resolve({
            action: "chat",
            reply: "Sorry, I couldn't process that. The AI response was malformed. Please try again.",
          });
        }
      });
    });

    req.on("error", (err) => {
      console.error("[brain] HTTPS request error:", err.message);
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("DeepSeek API request timed out"));
    });

    req.write(requestBody);
    req.end();
  });
}

module.exports = { decideAction };