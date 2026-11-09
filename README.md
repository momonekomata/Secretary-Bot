# Secretary Bot — your AI secretary and news curator for Telegram and LINE

A private assistant that lives in your Telegram and/or LINE chats, powered by **Gemini** by default and switchable to **Claude**
from a `/settings` menu. One bot process serves both apps, and it is built to run 24/7 on a NAS in Docker.

> **New to this?** Follow the step-by-step [beginner setup guide](SETUP-GUIDE.md) instead of this page.

## What it does

| | |
|---|---|
| 🤖 **Switchable AI** | Gemini 3.8 Flash (default), Gemini 4 Argon, Claude Sonnet 5.5, Claude Opus 5.5, Claude Haiku 5.5. `/settings` has buttons for the model, the thinking effort (low/medium/high) and the voice-translation language. |
| 🗓️ **Secretary** | Natural-language chat with tools: memories, reminders, a to-do list (`/todo`, `/add`, `/done`, `/clear`), and with Google connected: Calendar (read and add events), Gmail (read unread, **draft** replies; it never sends), Google Tasks, Drive search. Commands `/calendar`, `/inbox`, `/gtask`, `/drive`. |
| 📰 **News curator** | `/news [topic]` turns live Google News headlines into an executive briefing. A watchlist (`/topics`, `/addtopic`, `/removetopic`) drives the morning briefing. |
| 🌅 **Scheduled messages** | 07:00 weather report, 08:00 morning briefing (weather + AQI, today's calendar, unread email, tasks, to-dos, news per topic, WaniKani), Friday 16:00 weekend planner. On demand: `/weather [city]`, `/brief`, `/weekend`. `/setcity` changes the city. |
| 🌦️ **Weather & air quality** | Open-Meteo forecast, geocoding and air quality (US AQI, PM2.5), free with no key. Optional alert when AQI passes a threshold. |
| 🎙️ **Voice notes** | Gemini transcribes the audio directly (no ffmpeg), detects the language, translates it, then the agent summarises it and creates any tasks, events or reminders mentioned. |
| 📷 **Photos** | Send a picture of a sign, menu or textbook page and it reads and explains it. |
| 💵 **Cost control** | Every call's tokens and estimated cost are logged. `/stats` shows today, this month and per model. A daily warning limit and a hard cap pause the AI until midnight. Nightly cleanup archives logs older than 30 days to a `.csv.gz` (sent to you on Telegram); `/cleanup` runs it now. |
| 🩺 **Diagnostics** | `/status` checks the AI keys, the selected Gemini model, the Google sign-in, schedules and spend. After an automatic update the bot messages you the new version. |
| 🇯🇵 **Japanese study** | Readings for Japanese words, live WaniKani progress, optional daily study nudge. |

It is **private by default**: it only answers the user ids in its allowlist. Anyone else gets no reply.

## Quick start

Needs Node.js 20 or newer.

```bash
git clone https://github.com/momonekomata/Secretary-Bot.git
cd Secretary-Bot
npm install
npm run setup       # asks for each key and saves .env (or copy .env.example to .env)
npm start
```

| Key | Where |
|---|---|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) → Create API key. Needed for Gemini models and voice notes. |
| `ANTHROPIC_API_KEY` (optional) | [platform.claude.com](https://platform.claude.com) → Settings → API keys |
| `TELEGRAM_BOT_TOKEN` | Telegram **@BotFather** → `/newbot` |
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | [LINE Developers console](https://developers.line.biz/console/), Messaging API channel |
| Google | `credentials.json` (OAuth Desktop client) in `data/`, then `npm run google-auth`. See the guide, Part 3. |

Message the bot once: it replies with your user id for `TELEGRAM_ALLOWED_USERS` / `LINE_ALLOWED_USERS`. Send `/id` to get the chat
key for `BOT_NOTIFY_CHATS`, where scheduled messages go. All settings are listed in [.env.example](.env.example).

### Google

1. Create a Google Cloud project and enable the Calendar, Gmail, Tasks and Drive APIs (`npm run setup-gcp` does this with the
   `gcloud` CLI, or follow the guide).
2. Configure the OAuth consent screen (External, add yourself as a test user) and **publish it to "In production"**; in "Testing",
   Google expires refresh tokens after 7 days.
3. Create an OAuth client of type **Desktop app**, download it as `data/credentials.json`, run `npm run google-auth`.
   It works headless too: open the printed link anywhere and paste the redirected address back.

Scopes: `calendar.events`, `gmail.readonly`, `gmail.compose` (drafts only), `tasks`, `drive.readonly`. Email content is passed
to the AI as untrusted data, and the bot can only create drafts, so a malicious email cannot make it send mail.

## Run 24/7 on a NAS (Docker + automatic updates)

```
git push (main) ─► GitHub Actions: tests, multi-arch image (amd64 + arm64) ─► ghcr.io/momonekomata/secretary-bot:latest
                                                                                 │
NAS: docker compose ─► secretary-bot (+ ./data volume)  ◄── Watchtower pulls new images every 5 min and restarts
```

1. Push to `main`: `.github/workflows/docker.yml` publishes the image. Make the package public once (GitHub → Packages →
   secretary-bot → Package settings), or `docker login ghcr.io` on the NAS with a `read:packages` token.
2. On the NAS, put [docker-compose.yml](docker-compose.yml) in a folder with a `data/` folder holding `.env`, `credentials.json`
   and `token.json` (do `npm run setup` and `npm run google-auth` on your computer first, then copy them).
3. `docker compose up -d` (or Synology Container Manager → Project → Create). Set `TZ` so the schedules use local time.

Everything the bot keeps (conversations, memories, settings, usage log, Google token, backups) lives in `/data`, so updates keep it.
Telegram polling needs no open ports; LINE needs a public HTTPS URL to `/line` (e.g. a Cloudflare Tunnel or the NAS reverse proxy).

## Make it yours

- `BOT_NAME`, `BOT_TIMEZONE`, `BOT_PERSONA` (extra instructions), `WEATHER_CITY`, `NEWS_TOPICS`, `NEWS_LANGUAGE`/`NEWS_COUNTRY`.
- Schedules: `WEATHER_TIME`, `BRIEFING_TIME`, `WEEKEND_PLANNER_DAY`/`_TIME`, `CLEANUP_TIME` (empty disables).
- Spending: `DAILY_WARNING_LIMIT_USD`, `DAILY_HARD_LIMIT_USD`, `MODEL_PRICES` (override list prices used for estimates).
- Add a model to `MODELS` in `src/models.ts`, or select any Gemini/Claude id with `/model <id>`.
- New abilities are tools in `src/tools.ts`: add a spec and a `case` in `runTool`; both providers get it.

## How it works

```
Telegram ─┐                     ┌─ GeminiProvider (function calling)  ┐
          ├─► Secretary ─► Agent┤                                      ├─► tools: memories, reminders, to-dos, news,
LINE ─────┘   commands,         └─ ClaudeProvider (tool use + web)    ┘    weather/AQI, WaniKani, Google services
              voice (Gemini)
Scheduler (30 s) ─► reminders, weather, briefing, weekend planner, cleanup, AQI alert ─► Telegram / LINE
```

- `src/agent.ts`: picks the provider for the selected model, enforces the spending cap, logs usage, keeps text-only history.
- `src/llm/claude.ts`, `src/llm/gemini.ts`: the tool loops. Claude gets web search/fetch and server-side refusal fallbacks;
  Gemini gets thinking levels and keeps thought signatures intact between tool calls.
- `src/briefings.ts` (morning, weather, weekend, news, stats, cleanup), `src/commands.ts`, `src/channel.ts` (shared message
  handling and voice), `src/telegram.ts`, `src/line.ts`, `src/scheduler.ts`, `src/google.ts`, `src/news.ts`, `src/weather.ts`.

```bash
npm test            # unit tests (no network; AI services are faked)
npm run typecheck
```

Privacy: your messages go to Google's or Anthropic's API (whichever model is selected) to be answered. Conversations, memories,
settings, usage logs and the Google token are stored only in the data folder. `.env`, `data/`, `credentials.json` and
`token.json` are git-ignored; keep them secret.
