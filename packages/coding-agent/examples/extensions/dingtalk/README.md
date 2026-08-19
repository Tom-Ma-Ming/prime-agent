# DingTalk Bridge

Drive a Prime Agent session from DingTalk, and let a group watch it happen.

| Where the message comes from | What the bridge does |
|---|---|
| **Private chat** with the bot | Conversational. An allowlisted user talks to the agent 1:1 and gets the answer back. |
| **Group**, `mirror` mode (default) | Spectator. Every question and answer is broadcast into the group; nothing typed there reaches the agent. |
| **Group**, `interactive` mode | Opt-in. Allowlisted users may also drive the agent from the group; replies @-mention the asker. |
| **Terminal** (you typing in the TUI) | Mirrored into the spectator groups, so the group sees local work too. |

Inbound uses DingTalk **Stream mode**, so no public callback URL, domain, or ICP filing is
needed — the process dials out to DingTalk over a WebSocket. Outbound replies go back through
the originating conversation's session webhook, falling back to the proactive robot APIs when
that webhook has expired.

No npm dependencies: it uses the `WebSocket` and `fetch` globals from Node >= 22.

> [!WARNING]
> Prime Agent runs shell commands and model-generated Python with your user permissions, and its
> worker/kernel processes are **not** a security sandbox. Connecting it to a chat app hands that
> capability to whoever can message the bot. `DINGTALK_ALLOW_USERS` is mandatory for that reason,
> messages from a chat are untrusted input (prompt injection is a real risk here), and you should
> run the agent in a disposable checkout or a container. Groups stay read-only unless you
> explicitly opt into `interactive`.

## Setup

### 1. Create an internal DingTalk app

In the [DingTalk developer console](https://open-dev.dingtalk.com/): create an
**企业内部应用**, then note its **AppKey** and **AppSecret**.

- Under **机器人**, add a bot to the app and publish it.
- Set the bot's message-receiving mode to **Stream 模式**.
- Grant the app the permissions to send bot messages (1:1 and group).

### 2. Configure and run

Copy `dingtalk.example.json`, fill in the two credentials and your own staff id, and keep it
private — the file holds an AppSecret:

```bash
mkdir -p ~/bots
cp examples/extensions/dingtalk/dingtalk.example.json ~/bots/team-a.json
chmod 600 ~/bots/team-a.json
$EDITOR ~/bots/team-a.json

prime-agent --dingtalk-config ~/bots/team-a.json
```

Send the bot a private message. It should answer.

Don't know your staff id? Put a placeholder in `allowUsers` and message the bot: the refusal
reply tells you your own id, and the log line prints it too.

### 3. Wire up a spectator group

Add the bot to a group and @-mention it once. The bridge logs the conversation id:

```
[dingtalk] message from Alice in group cidXXXXXXXXXXXX=
```

Put that id in the config file's `mirrorConversations` and restart. The group now receives
every question and answer, including runs you start from the terminal.

## Running several bots

One JSON file per bot; pick one at launch:

```bash
prime-agent --dingtalk-config ~/bots/team-a.json     # in ~/work/service-a
prime-agent --dingtalk-config ~/bots/team-b.json     # in ~/work/service-b
```

Each session runs its own bot with its own allowlist and its own spectator groups.

**The file wins over environment variables.** Choosing a bot is the whole point of naming a
file, so a stale `DINGTALK_CLIENT_ID` left in a shell profile can never quietly connect the
wrong bot with this bot's allowlist. Environment variables only fill in keys the file omits.

### Where the config file comes from

Checked in order; the first hit is used:

1. `--dingtalk-config <path>` (relative paths resolve against the working directory)
2. `DINGTALK_CONFIG=<path>`
3. `.prime/agent/dingtalk.json`, searched from the working directory **up to the git repository
   root** — per-project bot, no flag needed
4. `~/.prime/agent/dingtalk.json` — your default bot

A path named by the flag or `DINGTALK_CONFIG` must exist; a missing file there is an error
rather than a silent fallback. The discovered defaults may be absent without complaint.

### One bot per repository

Put the config at the repository root and no flag is needed anywhere inside it:

```
my-service/
├── .git/
├── .prime/agent/dingtalk.json    ← this repo's bot
└── packages/api/                 ← `prime-agent` here finds it too
```

The search stops at the repository root, so a config in an outer directory never leaks into an
unrelated repository.

The file holds an AppSecret, so **gitignore it**:

```bash
echo ".prime/agent/dingtalk.json" >> .gitignore
```

Startup warns if the config is inside a git repository and not ignored, in case a `git add .`
would have published your credentials.

With **no** config file and no `DINGTALK_*` variables, the extension stays completely silent,
so it is safe to drop into `~/.prime/agent/extensions/` and have it load in every session.

## Configuration

| Config file key | Environment variable | Default | Purpose |
|---|---|---|---|
| `clientId` | `DINGTALK_CLIENT_ID` | — | **Required.** The app's AppKey; also the Stream client id. |
| `clientSecret` | `DINGTALK_CLIENT_SECRET` | — | **Required.** The app's AppSecret. |
| `allowUsers` | `DINGTALK_ALLOW_USERS` | — | **Required.** Staff ids allowed to drive the agent. |
| `mirrorConversations` | `DINGTALK_MIRROR_CONVERSATIONS` | empty | Group conversation ids that receive the mirror. |
| `groupMode` | `DINGTALK_GROUP_MODE` | `mirror` | `mirror` keeps groups read-only; `interactive` lets allowlisted users drive from a group. |
| `robotCode` | `DINGTALK_ROBOT_CODE` | `clientId` | Robot code for the proactive send APIs, when it differs from the AppKey. |
| `mirrorTools` | `DINGTALK_MIRROR_TOOLS` | `false` | Also broadcast each tool invocation. Noisy. |
| `maxChars` | `DINGTALK_MAX_CHARS` | `3500` | Split threshold for long answers. |
| `streamingBehavior` | `DINGTALK_STREAMING_BEHAVIOR` | `followUp` | How a question is queued mid-run: `followUp` waits, `steer` redirects the running turn. |
| `progressAfterMs` | `DINGTALK_PROGRESS_AFTER_MS` | `20000` | Send a "still working" note after this long. `0` disables it. |
| `noticeCooldownMs` | `DINGTALK_NOTICE_COOLDOWN_MS` | `3600000` | Minimum gap between repeats of the same refusal notice in one conversation. |
| `cardTemplateId` | `DINGTALK_CARD_TEMPLATE_ID` | unset | Enables AI-card streaming replies (see below). |
| `cardMarkdownKey` | `DINGTALK_CARD_MARKDOWN_KEY` | `content` | Card template variable holding the markdown body. |

List values accept either an array or one comma-separated string. Unknown keys are reported as
warnings rather than ignored, so a typo does not become a silently misbehaving bot.

## Chat commands

| Message | Effect |
|---|---|
| `/stop`, `/abort`, `停` | Abort the current run and drop the queue. |
| `/status`, `状态` | Report whether the agent is busy and how many questions are queued. |

Anything else is sent to the agent as a normal prompt, so `/skill:...` and prompt templates
still work.

## Streaming replies (optional)

By default a reply arrives as one message when the run finishes, because DingTalk cannot edit a
message after it is sent. To get a live, typewriter-style reply instead, create an **AI 卡片**
template in the developer console with a markdown variable, then add to the config file:

```json
{
	"cardTemplateId": "<template id>",
	"cardMarkdownKey": "content"
}
```

`cardMarkdownKey` must match the variable name in your template.

The bridge then creates one card per run and streams the answer into it, throttled to roughly
one update per 700 ms. If card creation or streaming fails, it falls back to a plain message —
a broken card never costs you the answer.

## How replies stay correlated

- Answers are queued FIFO. Each question is delivered with `followUp`, so it gets its own agent
  run and its own reply, in the order the questions were accepted.
- A group reply @-mentions the asker and titles the message with a short echo of the original
  question, since DingTalk group robots have no Slack-style threading.
- A run started from the terminal has no DingTalk asker; its answer only reaches the spectator
  groups.

## Echo safety

Three guards keep the bridge from talking to itself:

1. `input` events with `source === "extension"` are never mirrored — that source *is* this
   bridge's own injection coming back around.
2. Messages whose sender is the bot's own user id are dropped.
3. Message ids are de-duplicated, because the gateway redelivers frames whose ack it missed.

The bridge acks every frame immediately, before the agent runs: DingTalk's redelivery window is
far shorter than a real agent task.

## Limitations

- Text messages only. Images, files, and voice are ignored with a log line.
- Group replies @-mention the asker via the session webhook. Mention rendering through the
  proactive `groupMessages/send` path depends on your message template.
- One bot per session. Several bots means several `prime-agent` sessions, one config file each;
  a single session does not multiplex bots.
- One agent session serves every conversation of its bot. For per-user isolated sessions, run a
  bridge service against the SDK or `--mode rpc` instead of loading this extension.
