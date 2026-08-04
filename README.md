# Hermes Agent

A Telegram-controlled agentic assistant powered by the DeepSeek API.

**Hermes** is a Node.js backend that lets you control an AI agent through Telegram. It can
create, edit, and delete files inside a sandboxed workspace, run safe shell commands,
and auto-commit everything to GitHub — with strict safety guardrails.

## Architecture

```
Telegram User
     │
     ▼
┌─────────────┐     ┌──────────┐     ┌─────────────┐     ┌──────────┐
│  Telegram   │────▶│ server.js │────▶│  auth.js    │────▶│ brain.js │
│  Webhook    │     │ /webhook  │     │ authorized? │     │ DeepSeek │
└─────────────┘     └───────────┘     └─────────────┘     └──────────┘
                                                                │
                                                     JSON action │
                                                          ┌──────▼──────┐
                                                          │  tools.js   │
                                                          │ create_file │
                                                          │ edit_file   │
                                                          │ delete_file*│
                                                          │ run_command*│
                                                          └──────┬──────┘
                                                                 │
                                                    * requires YES confirmation
                                                                 │
                                                          ┌──────▼──────┐
                                                          │  /workspace │
                                                          │ + git push  │
                                                          └─────────────┘
```

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/AIconsciousness/hermesagent.git
cd hermesagent
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | API key from [platform.deepseek.com](https://platform.deepseek.com) |
| `TELEGRAM_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `AUTHORIZED_TELEGRAM_ID` | Your Telegram numeric user ID (from [@userinfobot](https://t.me/userinfobot)) |
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope |
| `GITHUB_REPO_URL` | `https://{GITHUB_TOKEN}@github.com/AIconsciousness/hermesagent.git` |
| `RENDER_EXTERNAL_URL` | Your Render app URL (e.g., `https://hermes-agent.onrender.com`) |

### 3. Run Locally

```bash
npm start
```

The server starts on port 3000. For local Telegram testing, use a tool like
[ngrok](https://ngrok.com/) to expose your localhost, set `RENDER_EXTERNAL_URL` to
your ngrok URL, and restart.

---

## Telegram Commands

Send any message to your bot — Hermes will:

1. **Authorize** you (checks your Telegram ID)
2. **Think** via DeepSeek (replies `🤔 Thinking...`)
3. **Execute** the AI-decided action

### Example Interactions

```
You: Create a file called hello.js that prints "Hello World"
Bot: 🤔 Thinking...
Bot: ✅ File created: hello.js

You: Run node hello.js
Bot: ⚠️ Confirm run_command? Reply YES within 60 seconds to proceed.

You: YES
Bot: ⏳ Executing confirmed action...
Bot: ✅ Command completed successfully:
     Hello World
```

---

## Supported Actions

| Action | Requires Confirmation | Description |
|---|---|---|
| `chat` | ❌ No | Plain conversation, no side effects |
| `create_file` | ❌ No | Creates a file inside `/workspace` |
| `edit_file` | ❌ No | Find-and-replace inside a `/workspace` file |
| `delete_file` | ✅ **YES** | Deletes a file inside `/workspace` |
| `run_command` | ✅ **YES** | Runs a safe command (allowlist only) |

### Allowed Commands (strict allowlist)

- `npm install`
- `npm test`
- `node <file>` (where `<file>` is inside `/workspace`)
- `git status`

---

## Safety (non-negotiable)

- **Path containment** — All file paths are resolved relative to `/workspace`. Path traversal
  (`../`, absolute paths, symlinks) is rejected.
- **Command allowlist** — Only four command patterns are allowed. Everything else is blocked.
- **Confirmation** — Destructive actions (`delete_file`, `run_command`) require an explicit
  `YES` reply within 60 seconds.
- **Action logging** — Every action is timestamped and written to `actions.log`.
- **Authorization** — Every single message is checked against `AUTHORIZED_TELEGRAM_ID`.

---

## Deploy to Render

1. **Create a Web Service** on [Render](https://dashboard.render.com)
2. **Build Command:** `npm install`
3. **Start Command:** `node server.js`
4. **Runtime:** Node
5. **Set all 6 environment variables** listed above
6. Deploy — the webhook auto-configures on startup

---

## File Structure

```
/hermes-agent
  /workspace          <- ALL agent-generated/edited files live ONLY here
  server.js           <- Express app, Telegram webhook route
  brain.js            <- Calls DeepSeek, decides what action to take
  tools.js            <- Actual functions the agent can execute
  auth.js             <- Checks sender is the authorized Telegram user
  .env.example        <- Template for required environment variables
  package.json        <- Dependencies and start script
```

## License

ISC