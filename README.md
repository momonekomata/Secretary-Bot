# Secretary Bot — your AI secretary and news curator for Telegram and LINE

A private assistant that lives in your Telegram and/or LINE chats, powered by **Gemini** by default and switchable to **Claude**
from a `/settings` menu. One bot process serves both apps, and it is built to run 24/7 on a NAS in Docker.

> **New to this?** Follow the step-by-step [beginner setup guide](SETUP-GUIDE.md) instead of this page.
> **Using it?** The [user manual](MANUAL.md) lists every feature and command.

## What it does

| | |
|---|---|
| 🤖 **Switchable AI** | Gemini 3.8 Flash (default), Gemini 4 Argon, Claude Sonnet 5.5, Claude Opus 5.5, Claude Haiku 5.5. `/settings` has buttons for the model, the thinking effort (low/medium/high) and the voice-translation language. |
| 🗓️ **Secretary** | Natural-language chat with tools: memories, one-off and **repeating** reminders (daily, weekdays, weekly, monthly), a to-do list (`/todo`, `/add`, `/done`, `/clear`). |
| 📧 **Google** | Calendar: all your calendars (shared, family), add, change and delete events. Gmail: read and search all mail, read full messages, **draft** replies (it never sends). Tasks: list, add, complete (`/gtask`, `/gdone`). Drive: search and read Docs, Sheets, Slides, PDFs and Word files. Docs: create and append. Sheets: read, append rows, create. Contacts: look up addresses. Commands `/calendar`, `/inbox`, `/mail`, `/drive`. (Google Keep has no API for personal accounts.) |
| 📍 **Maps & location** | Share your location in Telegram or LINE to set the weather city. With `GOOGLE_MAPS_API_KEY`: nearby places (`/places`) and live travel times. |
| 📄 **Files** | Send a PDF, Word (.docx), text/CSV file or image and ask about it. |
| 📰 **News curator** | `/news [topic]` turns live Google News headlines into an executive briefing. A watchlist (`/topics`, `/addtopic`, `/removetopic`) drives the morning briefing. |
| 🌅 **Scheduled messages** | 12:00 kanji and word of the day, 07:00 weather report, 08:00 morning briefing (weather + AQI, today's calendar, unread email, tasks, to-dos, news per topic, WaniKani), Friday 16:00 weekend planner. On demand: `/weather [city]`, `/brief`, `/weekend`. `/setcity` changes the city. |
| 🌦️ **Weather & air quality** | Open-Meteo forecast, geocoding and air quality (US AQI, PM2.5), free with no key. Optional alert when AQI passes a threshold. |
| 🎙️ **Voice** | Gemini transcribes voice notes (Telegram's Ogg directly, LINE's M4A via ffmpeg), detects the language, translates it, then the agent summarises it and creates any tasks, events or reminders mentioned. **Spoken replies** with Gemini TTS: `/voice off\|notes\|always`, `/say <text>` (Telegram voice bubbles; LINE audio via `PUBLIC_URL`). |
| 🔎 **Web search** | Both AIs can search the web and read pages: Gemini through Google Search grounding and URL context, Claude through its web search and fetch tools. `BOT_WEB_TOOLS=off` turns it off. |
| 📷 **Photos** | Send a picture of a sign, menu or textbook page and it reads and explains it. |
| 💵 **Cost control** | Every call's tokens and estimated cost are logged. `/stats` shows today, this month and per model. Daily warning limits and hard caps per provider (e.g. Gemini inside AI Pro credit, Claude inside Max credit): a provider's cap pauses only its models until midnight, and an optional overall cap pauses everything. Change the limits in chat with `/limit` (e.g. `/limit gemini 3`); they override `.env` until `/limit reset`. Nightly cleanup archives logs older than 30 days to a `.csv.gz` (sent to you on Telegram); `/cleanup` runs it now. |
| 🩺 **Diagnostics** | `/status` checks the AI keys, the selected Gemini model, the Google sign-in, schedules and spend. After an automatic update the bot messages you the new version. |
| 🎭 **Personality** | `/persona` picks a character (secretary, butler, cheerful friend, caring พี่, sensei, coach) or takes your own description in plain words; each comes with a matching voice and speaking style for spoken replies. `/name` renames the bot, `/ttsvoice` picks any Gemini voice. |
| 💰 **Budget & spending** | Send payment or transfer slips (several at once is fine): it reads the amount, date (Buddhist year too), shop or person, account and reference number, picks a category and logs it; re-sent slips are skipped. Co-pay schemes such as ไทยช่วยไทย 60/40 are logged at what you paid. `/budget` shows the month by category against your budget, `/budget set 20000` / `/budget set food 6000` set limits, `/budget start 25` makes the month run payday to payday. With Gmail it reads receipts, card alerts, bill payments, subscriptions and salary notices (`/budget scan`, and every evening at `MONEY_CHECK_TIME`), and warns at 80% and 100% of a budget. Savings and moves between your own accounts aren't counted as spending. |
| 📌 **Standing preferences** | `/prefs add Always reply in Thai`, `/prefs add Use emoji`, or just tell it ("from now on, always answer in Thai"). Preferences apply in every personality and roleplay, and are saved with your settings. |
| 💾 **Your data** | `/export` sends a .zip of CSV files (food diary, weight, daily health, workouts, Samsung food log, memories, AI usage) plus your profile and settings, ready for Excel or Google Sheets. |
| 🍽️ **Food diary & body** | Type what you ate or send a photo: the AI estimates average calories and macros and logs it. `/food` shows the day against your target; `/bmi` gives BMI (Asian cut-offs), BMR (Mifflin-St Jeor), daily burn and a calorie target from your profile; `/weight 65.5` keeps a weight history. Yesterday's total goes into the morning briefing. Photos with a **barcode** are read on the NAS and looked up in your personal food database, then Open Food Facts; nutrition labels and your corrections are saved there too (`/fooddb`). |
| ⌚ **Samsung watch & scale** | Reads the CSVs the Health Sync app uploads to Google Drive ("Health Sync Steps", "Heart rate", "Weight", "Activities", "Oxygen saturation", "Sleep", "Energy burned", in any folder): sleep with stages, steps, calories burned, heart rate, SpO2, workouts and smart-scale readings (weight, body fat, muscle, BMR). `/health [days]`, a summary in the morning briefing, and new weigh-ins flow into the weight history automatically. |
| 🗄️ **Health history** | Every synced day is kept in `data/healthdb.json`. `/healthimport` downloads a Samsung Health "Download personal data" export (.rar or .zip) from Drive and adds years of history (steps, sleep, heart rate, SpO2, workouts, calories, weight, plus HRV, breathing rate, stress, floors, water, blood pressure, height and food logged in Samsung Health); ask about long-term trends ("how has my sleep changed this year?"). |
| 💬 **Companion & roleplay** | A companion personality to chat with, and `/roleplay` scenes: stories, a detective mystery, or Japanese conversation practice (ramen shop, directions in Kyoto, job interview) with gentle corrections. `/roleplay end` stops. |
| 🈁 **Kanji & word of the day** | Sent daily at 12:00 (`JAPANESE_TIME`) or on demand with `/kanji` and `/word`: readings, meaning, example words or sentence, a memory trick and a mini quiz. With WaniKani it takes items from your current level with their real readings; otherwise it picks for your `/jlpt` level and never repeats recent ones. |
| 🈁 **WaniKani reviews in chat** | `/review` pulls your due reviews and quizzes them in Telegram or LINE: meaning, then reading in kana or romaji, with WaniKani-style typo tolerance, wrong items coming back later, and hints from the mnemonics. Each finished item is submitted to WaniKani (`POST /v2/reviews`, token needs `reviews:create`). The kanji and word of the day are picked from your due reviews when possible, so answering them counts. |
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
| `GOOGLE_MAPS_API_KEY` (optional) | Google Cloud → Credentials → API key, with Places API (New) and Routes API enabled (needs billing) |
| `PUBLIC_URL` (LINE) | A public https address for the bot (Tailscale Funnel or Cloudflare Tunnel); the bot sets the LINE webhook to `PUBLIC_URL/line` itself |

Message the bot once: it replies with your user id for `TELEGRAM_ALLOWED_USERS` / `LINE_ALLOWED_USERS`. Send `/id` to get the chat
key for `BOT_NOTIFY_CHATS`, where scheduled messages go. All settings are listed in [.env.example](.env.example).

### Google

1. Create a Google Cloud project and enable the Calendar, Gmail, Tasks, Drive, Docs, Sheets and People APIs (`npm run setup-gcp`
   does this with the `gcloud` CLI, or follow the guide).
2. Configure the OAuth consent screen (External, add yourself as a test user) and **publish it to "In production"**; in "Testing",
   Google expires refresh tokens after 7 days.
3. Create an OAuth client of type **Desktop app**, download it as `data/credentials.json`, run `npm run google-auth`.
   It works headless too: open the printed link anywhere and paste the redirected address back.

Scopes: `calendar.events`, `calendar.calendarlist.readonly`, `gmail.readonly`, `gmail.compose` (drafts only), `tasks`, `drive.readonly`,
`documents`, `spreadsheets`, `contacts.readonly`. Signed in with an older set? The bot keeps working with what it has, and `/status`
lists what is missing (run `npm run google-auth` again). Email content is passed
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

Everything the bot keeps (conversations, memories, settings, personality and preferences, food diary, weights, health history,
usage log, Google token) lives in `/data` (`store.json`, `healthdb.json`, `token.json`), so restarts, reboots and updates keep it.
Back that folder up (e.g. Synology Hyper Backup), and use `/export` for a copy you can open in a spreadsheet.
Telegram polling needs no open ports. LINE needs a public HTTPS address: run `tailscale funnel --bg 8787` on the NAS (free, no
domain) or uncomment the `cloudflared` service in `docker-compose.yml`, then set `PUBLIC_URL`. The image includes ffmpeg.

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
  Gemini gets thinking levels, keeps thought signatures intact between tool calls, and searches the web through
  `src/llm/gemini-web.ts` (Google Search grounding and URL context, each in its own small request).
- `src/briefings.ts` (morning, weather, weekend, news, stats, cleanup), `src/commands.ts`, `src/channel.ts` (shared message
  handling and voice), `src/telegram.ts`, `src/line.ts`, `src/scheduler.ts`, `src/google.ts`, `src/news.ts`, `src/weather.ts`.

```bash
npm test            # unit tests (no network; AI services are faked)
npm run typecheck
```

Privacy: your messages go to Google's or Anthropic's API (whichever model is selected) to be answered. Conversations, memories,
settings, usage logs and the Google token are stored only in the data folder. `.env`, `data/`, `credentials.json` and
`token.json` are git-ignored; keep them secret.
