/**
 * tools.js — Action executor for Hermes.
 * Every function that modifies files or runs commands lives here.
 *
 * SAFETY REQUIREMENTS (non-negotiable):
 * - All file paths MUST resolve inside /workspace
 * - run_command uses a strict allowlist
 * - delete_file and run_command require explicit YES confirmation
 * - Every action is logged to actions.log
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const simpleGit = require("simple-git");

// Resolve the absolute path to the workspace directory
const WORKSPACE_DIR = path.resolve(__dirname, "workspace");

// Log file path
const LOG_FILE = path.resolve(__dirname, "actions.log");

// ============================================================================
// CONFIRMATION STATE
// Stores pending confirmations keyed by Telegram chat ID.
// Each entry: { action, expiresAt, ...actionParams }
// ============================================================================
const pendingConfirmations = new Map();

// Clean up expired confirmations every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [chatId, entry] of pendingConfirmations.entries()) {
    if (now > entry.expiresAt) {
      pendingConfirmations.delete(chatId);
      console.log(`[tools] Expired confirmation for chat ${chatId}`);
    }
  }
}, 30000);

// ============================================================================
// PATH SAFETY — Enforce /workspace boundary
// ============================================================================

/**
 * Resolves a relative path to an absolute path inside /workspace.
 * Returns null if the path tries to escape /workspace.
 *
 * @param {string} relativePath — Relative path from the agent (e.g., "src/index.js")
 * @returns {string|null} — Absolute resolved path, or null if unsafe.
 */
function resolveWorkspacePath(relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    return null;
  }

  // Normalize: strip leading slashes, convert backslashes
  let cleanPath = relativePath.replace(/^[/\\]+/, "").replace(/\\/g, "/");

  // Resolve to absolute
  const absolute = path.resolve(WORKSPACE_DIR, cleanPath);

  // MUST start with WORKSPACE_DIR (prevents path traversal like ../../../etc/passwd)
  if (!absolute.startsWith(WORKSPACE_DIR + path.sep) && absolute !== WORKSPACE_DIR) {
    console.warn(`[tools] PATH ESCAPE ATTEMPT: "${relativePath}" resolved to "${absolute}"`);
    return null;
  }

  return absolute;
}

// ============================================================================
// LOGGING
// ============================================================================

/**
 * Appends an entry to the actions.log file.
 * @param {string} action — Action type (create_file, edit_file, delete_file, run_command)
 * @param {string} target — The path or command involved
 * @param {string} result — "success" or "error"
 * @param {string} details — Additional info
 */
function logAction(action, target, result, details = "") {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] action=${action} target="${target}" result=${result} ${details}\n`;
  fs.appendFileSync(LOG_FILE, line, "utf8");
}

// ============================================================================
// ALLOWED COMMANDS (strict allowlist)
// ============================================================================

const ALLOWED_COMMANDS = [
  "npm install",
  "npm test",
  "git status",
];

/**
 * Checks if a command is on the allowlist.
 * Also allows "node <file>" where <file> is inside /workspace.
 *
 * @param {string} command — The command string to validate.
 * @returns {{ allowed: boolean, reason?: string }}
 */
function isCommandAllowed(command) {
  if (!command || typeof command !== "string") {
    return { allowed: false, reason: "No command provided." };
  }

  const trimmed = command.trim();

  // Check exact allowlist matches
  if (ALLOWED_COMMANDS.includes(trimmed)) {
    return { allowed: true };
  }

  // Allow "node <workspace-file>" pattern
  const nodeMatch = trimmed.match(/^node\s+(.+)$/);
  if (nodeMatch) {
    const fileArg = nodeMatch[1].trim();
    const resolved = resolveWorkspacePath(fileArg);
    if (!resolved) {
      return {
        allowed: false,
        reason: `"${fileArg}" resolves outside /workspace. Rejected.`,
      };
    }
    if (!fs.existsSync(resolved)) {
      return {
        allowed: false,
        reason: `File "${fileArg}" does not exist inside /workspace.`,
      };
    }
    // Reconstruct the command with the safe resolved path
    return { allowed: true, safeCommand: `node "${resolved}"` };
  }

  return {
    allowed: false,
    reason: `Command "${trimmed}" is not on the allowlist. Allowed: npm install, npm test, node <workspace-file>, git status.`,
  };
}

// ============================================================================
// GIT AUTO-COMMIT
// ============================================================================

/**
 * Stages all changes in /workspace, commits with a message, and pushes.
 * The commit message is truncated to 72 characters.
 *
 * @param {string} commitMessage — The user's original Telegram message.
 * @returns {Promise<string>} — Success or error message.
 */
async function gitCommitAndPush(commitMessage) {
  const git = simpleGit(WORKSPACE_DIR);

  // Check if workspace is inside a git repo; if not, initialize one
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    console.log("[tools] Workspace is not a git repo — initializing...");
    await git.init();
  }

  // Always ensure a git identity is configured (Render containers often lack one,
  // which makes `git commit` fail with "Please tell me who you are")
  try {
    await git.addConfig("user.name", "Hermes Agent");
    await git.addConfig("user.email", "hermes@agent.local");
  } catch (e) {
    console.log("[tools] git config note:", e.message);
  }

  // Always (re)point origin at the token-embedded URL so pushes are authenticated.
  // On Render the clone's origin has no push credentials, which is why the
  // original code never actually pushed — this fixes that.
  const repoUrl = process.env.GITHUB_REPO_URL;
  if (repoUrl) {
    try {
      await git.removeRemote("origin");
    } catch (e) {
      // no origin yet — fine
    }
    try {
      await git.addRemote("origin", repoUrl);
    } catch (e) {
      console.log("[tools] addRemote note:", e.message);
    }
  } else {
    return "GITHUB_REPO_URL not set — skipping git push.";
  }

  try {
    // Truncate commit message to 72 chars
    const truncated = commitMessage.substring(0, 72);

    // Stage everything
    await git.add(".");

    // Check if there is anything to commit
    const status = await git.status();
    if (!status.staged.length && !status.created.length && !status.modified.length && !status.deleted.length) {
      return "No changes to commit.";
    }

    // Commit
    const commitResult = await git.commit(truncated);
    console.log("[tools] Git commit:", commitResult.commit);

    // Push the current HEAD to the remote main branch.
    // IMPORTANT: Render deploys in a DETACHED-HEAD state (it checks out a
    // specific commit, not a branch), so a plain `git push origin main` is a
    // no-op — the local "main" branch ref never moves and git reports
    // "already updated". Pushing HEAD:main explicitly sends the latest commit.
    let pushResult;
    try {
      pushResult = await git.push(["origin", "HEAD:main"]);
    } catch (e) {
      try {
        pushResult = await git.push(["origin", "HEAD:master"]);
      } catch (e2) {
        console.error("[tools] Push failed:", e2.message);
        return `Git push failed: ${e2.message}`;
      }
    }

    console.log("[tools] Git push:", pushResult);
    return "Changes committed and pushed to GitHub.";
  } catch (err) {
    console.error("[tools] Git error:", err.message);
    return `Git operation failed: ${err.message}`;
  }
}

// ============================================================================
// ACTION HANDLERS
// ============================================================================

/**
 * Creates a new file inside /workspace.
 * Fails if the path escapes /workspace or if the file already exists.
 *
 * @param {string} relativePath — Relative file path.
 * @param {string} content — File content.
 * @returns {{ success: boolean, message: string }}
 */
function actionCreateFile(relativePath, content) {
  const resolved = resolveWorkspacePath(relativePath);
  if (!resolved) {
    logAction("create_file", relativePath, "error", "path escape attempt");
    return { success: false, message: `Error: Path "${relativePath}" is outside /workspace. Rejected.` };
  }

  if (fs.existsSync(resolved)) {
    logAction("create_file", resolved, "error", "file already exists");
    return { success: false, message: `Error: File "${relativePath}" already exists. Use edit_file to modify it.` };
  }

  // Ensure parent directories exist
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(resolved, content, "utf8");
  logAction("create_file", resolved, "success", `bytes=${Buffer.byteLength(content, "utf8")}`);
  return { success: true, message: `File created: ${relativePath}` };
}

/**
 * Edits a file inside /workspace by finding and replacing text.
 * Fails if the path escapes /workspace or if the find text is not found.
 *
 * @param {string} relativePath — Relative file path.
 * @param {string} find — Exact text to find.
 * @param {string} replace — Replacement text.
 * @returns {{ success: boolean, message: string }}
 */
function actionEditFile(relativePath, find, replace) {
  const resolved = resolveWorkspacePath(relativePath);
  if (!resolved) {
    logAction("edit_file", relativePath, "error", "path escape attempt");
    return { success: false, message: `Error: Path "${relativePath}" is outside /workspace. Rejected.` };
  }

  if (!fs.existsSync(resolved)) {
    logAction("edit_file", resolved, "error", "file not found");
    return { success: false, message: `Error: File "${relativePath}" does not exist.` };
  }

  const original = fs.readFileSync(resolved, "utf8");

  if (!original.includes(find)) {
    logAction("edit_file", resolved, "error", "find text not found in file");
    return {
      success: false,
      message: `Error: Could not find the specified text in "${relativePath}". The file was not modified.`,
    };
  }

  // Replace only the FIRST occurrence
  const modified = original.replace(find, replace);
  fs.writeFileSync(resolved, modified, "utf8");
  logAction("edit_file", resolved, "success", `replaced ${find.length} chars`);
  return { success: true, message: `File edited: ${relativePath}` };
}

/**
 * Reads a file (or lists a directory) inside /workspace.
 * Read-only — no confirmation needed, no git commit.
 *
 * @param {string} relativePath — Relative file/dir path.
 * @returns {{ success: boolean, message: string }}
 */
function actionReadFile(relativePath) {
  const resolved = resolveWorkspacePath(relativePath);
  if (!resolved) {
    logAction("read_file", relativePath, "error", "path escape attempt");
    return { success: false, message: `Error: Path "${relativePath}" is outside /workspace. Rejected.` };
  }

  if (!fs.existsSync(resolved)) {
    logAction("read_file", resolved, "error", "file not found");
    return { success: false, message: `Error: File "${relativePath}" does not exist.` };
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(resolved);
    logAction("read_file", resolved, "success", `directory listing ${files.length} items`);
    return {
      success: true,
      message: `📁 Directory "${relativePath}":\n${files.length ? files.join("\n") : "(empty)"}`,
    };
  }

  const content = fs.readFileSync(resolved, "utf8");
  logAction("read_file", resolved, "success", `bytes=${content.length}`);
  return { success: true, message: `📄 "${relativePath}":\n${content.substring(0, 3500)}` };
}

/**
 * Deletes a file inside /workspace. REQUIRES CONFIRMATION.
 *
 * @param {string} relativePath — Relative file path.
 * @returns {{ success: boolean, message: string }}
 */
function actionDeleteFile(relativePath) {
  const resolved = resolveWorkspacePath(relativePath);
  if (!resolved) {
    logAction("delete_file", relativePath, "error", "path escape attempt");
    return { success: false, message: `Error: Path "${relativePath}" is outside /workspace. Rejected.` };
  }

  if (!fs.existsSync(resolved)) {
    logAction("delete_file", resolved, "error", "file not found");
    return { success: false, message: `Error: File "${relativePath}" does not exist.` };
  }

  // Check if it's a directory
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    logAction("delete_file", resolved, "error", "is a directory");
    return { success: false, message: `Error: "${relativePath}" is a directory. Only files can be deleted.` };
  }

  fs.unlinkSync(resolved);
  logAction("delete_file", resolved, "success", "");
  return { success: true, message: `File deleted: ${relativePath}` };
}

/**
 * Runs a shell command. REQUIRES CONFIRMATION.
 * Only allows commands on the strict allowlist.
 *
 * @param {string} command — The command to run.
 * @returns {Promise<{ success: boolean, message: string }>}
 */
function actionRunCommand(command) {
  return new Promise((resolve) => {
    const check = isCommandAllowed(command);
    if (!check.allowed) {
      logAction("run_command", command, "error", check.reason);
      resolve({ success: false, message: `Error: ${check.reason}` });
      return;
    }

    const cmdToRun = check.safeCommand || command;
    const options = {
      cwd: WORKSPACE_DIR,
      timeout: 30000, // 30-second timeout
      maxBuffer: 1024 * 1024, // 1MB output buffer
    };

    exec(cmdToRun, options, (error, stdout, stderr) => {
      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + stderr;

      if (error) {
        logAction("run_command", cmdToRun, "error", error.message);
        resolve({
          success: false,
          message: `Command failed (exit code ${error.code}):\n${output.substring(0, 2000)}`,
        });
      } else {
        logAction("run_command", cmdToRun, "success", `output=${output.length} chars`);
        resolve({
          success: true,
          message: `Command completed successfully:\n${output.substring(0, 2000) || "(no output)"}`,
        });
      }
    });
  });
}

// ============================================================================
// CONFIRMATION LOGIC
// ============================================================================

/**
 * Registers a pending confirmation for a destructive action.
 *
 * @param {number|string} chatId — Telegram chat ID.
 * @param {object} action — The action object to execute upon confirmation.
 * @returns {string} — Prompt message for the user.
 */
function requestConfirmation(chatId, action) {
  const expiresAt = Date.now() + 60000; // 60 seconds
  pendingConfirmations.set(String(chatId), {
    action,
    expiresAt,
  });
  console.log(`[tools] Confirmation requested for chat ${chatId}: ${action.action}`);
  return `⚠️ Confirm ${action.action}? Reply YES within 60 seconds to proceed.`;
}

/**
 * Checks if there's a pending confirmation for a chat and the reply is "YES".
 *
 * @param {number|string} chatId — Telegram chat ID.
 * @param {string} replyText — The user's reply text.
 * @returns {object|null} — The pending action if confirmed, or null.
 */
function checkConfirmation(chatId, replyText) {
  const key = String(chatId);
  const entry = pendingConfirmations.get(key);

  if (!entry) return null;

  // Clean up regardless
  pendingConfirmations.delete(key);

  if (Date.now() > entry.expiresAt) {
    return { expired: true };
  }

  const answer = replyText.trim().toUpperCase();
  if (answer !== "YES") {
    return { declined: true };
  }

  return { confirmed: true, action: entry.action };
}

/**
 * Executes a confirmed action after user approves.
 *
 * @param {object} action — The action object.
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function executeConfirmedAction(action) {
  switch (action.action) {
    case "delete_file":
      return actionDeleteFile(action.path);

    case "run_command":
      return await actionRunCommand(action.command);

    default:
      return { success: false, message: `Unknown confirmed action: ${action.action}` };
  }
}

// ============================================================================
// MAIN DISPATCHER — Called by server.js
// ============================================================================

/**
 * Executes an action determined by brain.js.
 * For destructive actions, returns a confirmation prompt instead
 * of executing immediately.
 *
 * @param {object} action — The action object from brain.js.
 * @param {number|string} chatId — Telegram chat ID (for confirmation tracking).
 * @returns {Promise<{ success: boolean, message: string, needsConfirmation?: boolean }>}
 */
async function executeAction(action, chatId) {
  console.log(`[tools] Executing action: ${action.action}`, JSON.stringify(action));

  switch (action.action) {
    case "chat":
      // Chat actions have no side effects — just return the reply
      logAction("chat", "n/a", "success", `reply=${(action.reply || "").length} chars`);
      return { success: true, message: action.reply || "(no reply)" };

    case "read_file":
      // Read-only — no confirmation, no git commit
      return actionReadFile(action.path);

    case "create_file":
      return actionCreateFile(action.path, action.content);

    case "edit_file":
      return actionEditFile(action.path, action.find, action.replace);

    case "delete_file": {
      // Validate path first
      const resolved = resolveWorkspacePath(action.path);
      if (!resolved) {
        return { success: false, message: `Error: Path "${action.path}" is outside /workspace.` };
      }
      if (!fs.existsSync(resolved)) {
        return { success: false, message: `Error: File "${action.path}" does not exist.` };
      }
      // Require confirmation
      const prompt = requestConfirmation(chatId, action);
      return { success: true, message: prompt, needsConfirmation: true };
    }

    case "run_command": {
      // Validate command first
      const check = isCommandAllowed(action.command);
      if (!check.allowed) {
        return { success: false, message: `Error: ${check.reason}` };
      }
      // Require confirmation
      const prompt = requestConfirmation(chatId, action);
      return { success: true, message: prompt, needsConfirmation: true };
    }

    default:
      logAction("unknown", JSON.stringify(action), "error", "unknown action type");
      return { success: false, message: `Error: Unknown action type "${action.action}".` };
  }
}

module.exports = {
  executeAction,
  checkConfirmation,
  executeConfirmedAction,
  gitCommitAndPush,
  WORKSPACE_DIR,
};