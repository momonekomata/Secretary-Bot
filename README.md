# Secretary Bot — your personal AI agent for Telegram and LINE

A private Claude-powered assistant that lives in your Telegram and/or LINE chats. One bot process serves both apps.

What it can do:

- **Chat about anything**, in whatever language you write (Thai, English, Japanese…).
- **Remember things about you** across conversations ("remember my JLPT exam is on 6 December"). Say "forget that" to remove one.
- **Set reminders** ("remind me at 9pm to do my reviews", "in 2 hours tell me to stretch"). It messages you when they're due.
- **Read photos**: send a picture of a sign, menu or textbook page and it reads and explains the Japanese.
- **Search and read the web** for current information.
- **Check your WaniKani progress** live, and optionally send a daily nudge when reviews are waiting.
- Commands: `/help`, `/reset` (clears the conversation but keeps memories and reminders), `/id`.

It is **private by default**: it only answers the user ids you list in the allowlist. Anyone else gets no reply.

> **New to this?** Follow the step-by-step [beginner setup guide](SETUP-GUIDE.md) instead of this page.

## 1. Get the keys

| What | Where |
|---|---|
| `ANTHROPIC_API_KEY` (required) | [platform.claude.com](https://platform.claude.com) → Settings → API keys |
| `TELEGRAM_BOT_TOKEN` | In Telegram, chat with **@BotFather** → `/newbot` → copy the token |
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | [LINE Developers console](https://developers.line.biz/console/) → create a provider → create a **Messaging API** channel. *Basic settings* → Channel secret; *Messaging API* → issue a channel access token (long-lived) |
| `WANIKANI_TOKEN` (optional) | wanikani.com → Settings → API Tokens (no permissions needed) |

You can set up just Telegram, just LINE, or both.

## 2. Run it

Needs Node.js 20 or newer.

```bash
git clone https://github.com/momonekomata/Secretary-Bot.git
cd Secretary-Bot
npm install
npm run setup            # asks for each key and saves .env
# (or: cp .env.example .env and edit it by hand)
npm start
```

### Telegram

With the default `TELEGRAM_MODE=polling` the bot fetches messages itself, so **no public URL is needed**: running it on your
own computer or a Raspberry Pi works. Open your bot in Telegram and send any message. It replies with your user id; put that
in `TELEGRAM_ALLOWED_USERS` and restart. Done.

### LINE

LINE delivers messages by webhook, so the bot needs a public HTTPS address.

1. Get one, either:
   - Quick test from your computer: `npx cloudflared tunnel --url http://localhost:8787` and copy the `https://….trycloudflare.com` URL it prints
     (it changes every run), or
   - Host the bot on a server (see *Hosting* below).
2. LINE Developers console → your channel → *Messaging API*:
   - **Webhook URL**: `https://<your-host>/line` → *Verify* → turn **Use webhook** on.
   - Under *LINE Official Account features*, turn **Auto-reply messages** off (otherwise LINE answers before the bot does).
3. Add the bot as a friend with the QR code on that page and send it a message. It replies with your LINE user id (starts with `U`);
   put that in `LINE_ALLOWED_USERS` and restart.

The bot answers with LINE's free *reply* messages. Reminders, nudges, and answers that take longer than LINE's reply window
are sent as *push* messages, which count toward your LINE plan's monthly message quota (the free plan includes a small number).

### Daily study nudge (optional)

Set `WANIKANI_TOKEN`, `BOT_DAILY_NUDGE_HOUR` (e.g. `20` for 8pm in `BOT_TIMEZONE`) and `BOT_DAILY_NUDGE_CHATS`
(the chat ids from `/id`, e.g. `telegram:123456789,line:Uxxxx`). Once a day at that hour, if reviews or lessons are waiting,
the bot messages you.

## 3. Make it yours

- `BOT_NAME`, `BOT_TIMEZONE`.
- `BOT_PERSONA`: extra instructions, e.g. `Be cheerful and call me senpai. Explain grammar with Thai examples.`
- `BOT_MODEL`: defaults to `claude-opus-5-5`. `claude-sonnet-5-5` or `claude-haiku-5-5` cost less per message.
- `BOT_EFFORT`: how hard it thinks, `low` … `max` (default `medium`). `low` is faster and cheaper for casual chat.
- `BOT_WEB_TOOLS=off` turns off web search and fetch.
- New abilities are tools in `src/tools.ts`: add a definition to `customTools` and a `case` in `runTool`.

## Hosting

It is one small Node process plus a data folder (`BOT_DATA_DIR`, default `./data`, holding conversations, memories and reminders
as JSON). Any always-on machine works: a home PC or Raspberry Pi (Telegram polling needs no open ports), a VPS, or a container host
such as Fly.io or Railway with a persistent volume mounted at `/data`.

Docker:

```bash
docker build -t secretary-bot .
docker run -d --restart unless-stopped --env-file .env -v secretary-bot-data:/data -p 8787:8787 secretary-bot
```

Telegram can also use a webhook instead of polling when you host it publicly: `TELEGRAM_MODE=webhook`,
`TELEGRAM_WEBHOOK_URL=https://<your-host>/telegram`, and a random `TELEGRAM_WEBHOOK_SECRET`.

## How it works

```
Telegram (polling/webhook) ─┐                       ┌─ remember / forget
                            ├─► Agent (Claude) ◄────┼─ set / list / cancel reminders
LINE (webhook /line) ───────┘     tool loop         ├─ get_wanikani_status
                                                    └─ web_search, web_fetch (run by Anthropic)
Scheduler (every 30 s) ─► due reminders + daily nudge ─► Telegram / LINE push
```

- `src/agent.ts`: the agent loop. Each message runs Claude with the tools until it produces a reply. Earlier turns are
  kept as plain text; the current time and your memories are added as a short system note on each turn. If Claude's safety
  checks decline a request, the API retries it on its recommended fallback model (`fallbacks: "default"`).
- `src/telegram.ts`, `src/line.ts`: platform adapters (LINE webhooks are signature-checked).
- `src/store.ts`: JSON file storage. `src/scheduler.ts`: reminders and the daily nudge.

```bash
npm test          # unit tests (no network, Claude is faked)
npm run typecheck
```

Privacy: messages you send go to Anthropic's API to be answered, and to Telegram/LINE as usual. The bot stores your recent
conversation, memories and reminders only in its data folder. Keep `.env` secret; it is git-ignored.
