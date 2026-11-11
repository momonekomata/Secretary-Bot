# Secretary Bot: User Manual

Everything your bot can do, in one place. For installing it, see [SETUP-GUIDE.md](SETUP-GUIDE.md).

The bot lives in your Telegram (and optionally LINE) chat. Most of the time you don't need commands: **just talk to it**,
send a photo, a file, a voice note or your location, and it works out what to do. Commands are shortcuts.

In Telegram, tap the **/** button for the command menu. Send `/help` for a short summary.

---

## Contents

1. [Talking to the bot](#1-talking-to-the-bot)
2. [Command quick reference](#2-command-quick-reference)
3. [Secretary: to-dos, reminders, memories](#3-secretary-to-dos-reminders-memories)
4. [Google: Calendar, Gmail, Tasks, Drive, Docs, Sheets, Contacts](#4-google-calendar-gmail-tasks-drive-docs-sheets-contacts)
5. [Maps and places](#5-maps-and-places)
6. [News](#6-news)
7. [Weather and air quality](#7-weather-and-air-quality)
8. [Briefings and automatic messages](#8-briefings-and-automatic-messages)
9. [Money: spending and budgets](#9-money-spending-and-budgets)
10. [Food diary and body](#10-food-diary-and-body)
11. [Samsung watch and health history](#11-samsung-watch-and-health-history)
12. [Japanese: WaniKani, kanji and word of the day](#12-japanese-wanikani-kanji-and-word-of-the-day)
13. [Personality, preferences and roleplay](#13-personality-preferences-and-roleplay)
14. [Voice](#14-voice)
15. [AI models, thinking effort and costs](#15-ai-models-thinking-effort-and-costs)
16. [Your data: where it's kept, backups, export](#16-your-data-where-its-kept-backups-export)
17. [Settings file (.env) reference](#17-settings-file-env-reference)
18. [Privacy and safety](#18-privacy-and-safety)
19. [Troubleshooting](#19-troubleshooting)

---

## 1. Talking to the bot

| You send | What happens |
|---|---|
| **A message** | It answers, and uses its tools when needed: it searches the web, checks your calendar, sets a reminder, logs food or spending. |
| **A photo of food or a drink** | It estimates calories and macros and adds them to your food diary. |
| **A payment / transfer slip** | It reads it and logs the spending (see [Money](#9-money-spending-and-budgets)). Several slips at once are fine. |
| **Any other photo** | It describes it, reads text in it, or translates it (e.g. a Japanese sign or menu). |
| **A voice note** (Thai, English, Japanese…) | It transcribes and translates it, then replies. Any to-dos or reminders you mention are created. |
| **A file**: PDF, Word (.docx) or text | It reads it, so you can ask about it ("what's the total on this invoice?"). Up to about 15 MB. |
| **Your location** | It becomes your weather city, and it can find places near you. |

Examples:
- "Remind me at 9pm to do my reviews"
- "Do I have time for the dentist tomorrow afternoon?"
- "Draft an email to sarah@example.com about the Q4 deck"
- "What's the latest on the Thai economy?"
- "How has my sleep changed this year?"
- "How much did I spend on food last month?"

It replies in the language you write in, unless you set a preference (see [Preferences](#132-standing-preferences)).

It remembers the recent conversation. `/reset` forgets the conversation but keeps memories, to-dos and reminders.

---

## 2. Command quick reference

### General
| Command | What it does |
|---|---|
| `/help` (or `/start`) | Short summary of everything |
| `/status` | Checks every connection (AI, Google, Maps, WaniKani…) |
| `/reset` | Forget this conversation (memories, to-dos and reminders stay) |
| `/id` | Shows your user id and this chat's id (needed in setup) |

### Secretary
| Command | What it does |
|---|---|
| `/todo` | Show your to-do list |
| `/add <task>` | Add a to-do, e.g. `/add Call the dentist` |
| `/done <id>` | Mark a to-do done, e.g. `/done 12` |
| `/clear` | Clear the whole to-do list |

### Google
| Command | What it does |
|---|---|
| `/calendar [days]` | Upcoming events across all your calendars (default today; up to 31 days) |
| `/inbox` | Unread Gmail (Primary tab) |
| `/mail <search>` | Search Gmail, e.g. `/mail from:ken contract newer_than:14d` |
| `/gtask` | Show Google Tasks; `/gtask <title>` adds one |
| `/gdone <number or words>` | Tick off a Google Task |
| `/drive [search]` | Recent or matching Google Drive files |
| `/places <what>` | Find places, e.g. `/places ramen near Asok` |

### News, weather and briefings
| Command | What it does |
|---|---|
| `/news [topic]` | News digest of your watchlist, or one topic |
| `/topics` | Show your news watchlist |
| `/addtopic <topic>` / `/removetopic <topic or number>` | Change the watchlist |
| `/brief` | Morning briefing now |
| `/weather [city]` | Today's weather and air quality |
| `/forecast [city]` | 7-day forecast |
| `/weekend [city]` | Weekend planner |
| `/setcity <city>` | Set your home city for weather and places |

### Money
| Command | What it does |
|---|---|
| `/budget` (or `/money`) | This month's spending by category against your budget |
| `/budget last` | Last month |
| `/budget list` | Recent transactions with their numbers |
| `/budget set 20000` | Monthly budget (`0` removes it) |
| `/budget set food 6000` | Budget for one category (`0` removes it) |
| `/budget start 25` | Budget month runs payday to payday (from the 25th) |
| `/budget edit 12 food` | Change a transaction's category |
| `/budget remove 12` | Delete a transaction |
| `/budget scan [days]` | Read receipts, card alerts, bills and salary from Gmail (default 30 days) |

### Food, body and health
| Command | What it does |
|---|---|
| `/food` | Today's food and calories (`/food yesterday`, `/food 2026-11-01`) |
| `/fooddb` | Your personal food database (barcodes, labels, your corrections); `/fooddb <words>` searches, `/fooddb remove <#>` |
| `/food remove <id>` | Delete a food entry |
| `/bmi` | BMI, BMR, daily burn and calorie target |
| `/profile` | Your body profile (and how to change it) |
| `/weight 65.5` | Log today's weight; `/weight` alone shows recent weights |
| `/health [days]` | Watch data for the last days (default 2, up to 14) |
| `/healthimport` | Import a Samsung Health export from Google Drive (`/healthimport status` shows progress) |

### Japanese
| Command | What it does |
|---|---|
| `/review [count]` | Do your WaniKani reviews in the chat (default 10); `/review stop` ends |
| `/kanji` | Kanji of the day |
| `/word` | Japanese word of the day |
| `/jlpt N4` | Level for kanji/word of the day when WaniKani isn't connected (N5–N1) |

### Personality, preferences, roleplay
| Command | What it does |
|---|---|
| `/persona` | Choose a personality, or `/persona <description>` for your own; `/persona off` resets |
| `/name <name>` | Rename the bot, e.g. `/name Mali` |
| `/prefs` | Your standing preferences |
| `/prefs add <text>` / `/prefs remove <n>` / `/prefs clear` | Change them |
| `/roleplay` | Pick a scene, or `/roleplay <description>`; `/roleplay end` stops |

### Voice
| Command | What it does |
|---|---|
| `/voice off` / `/voice notes` / `/voice always` | When to answer with a spoken voice message |
| `/say` (reply) | **Reply to any message with `/say` or 🔊** and I read it aloud; `/say` alone reads my last reply |
| `/say <text>` | Speak any text, e.g. `/say おはようございます` |
| `/voicestyle` | How the voice speaks: ready-made styles (cute, anime heroine, gentle, energetic, calm) or your own words, e.g. `/voicestyle shy and sweet, high-pitched`; `/voicestyle off` |
| `/voices` | Hear 8 cute female voice samples (Japanese + Thai) in one go, then tap one to use it; `/voices more` for 6 more |
| `/ttsvoice th Leda` / `/ttsvoice ja Autonoe` | A different voice for Thai and for Japanese (`/ttsvoice ja off` to undo); `/ttsvoice Leda` sets one voice for all |
| `/ttsvoice` | Pick the speaking voice with buttons (plays a sample); or `/ttsvoice Sulafat` for any of Gemini's 30 voices |
| `/translate <language>` | Which language voice notes are translated into |

### Settings and costs
| Command | What it does |
|---|---|
| `/settings` | Buttons for AI model, thinking effort and voice translation |
| `/model <id>` | Switch model directly, e.g. `/model claude-sonnet-5-5` |
| `/effort low\|medium\|high` | How hard the AI thinks |
| `/stats` | AI usage and cost (today, this week, this month) |
| `/limit` | Daily spending limits in USD, with buttons; `/limit gemini 3`, `/limit claude warn 1`, `/limit all 5`, `/limit gemini off`, `/limit reset` |
| `/cleanup` | Archive old usage logs now (also runs every night) |
| `/export` | Download all your data as a .zip |

---

## 3. Secretary: to-dos, reminders, memories

**To-dos.** Use `/add`, `/todo` and `/done`, or say "add buy rice to my list" or "what's on my list?".

**Reminders.** Say it in plain words:
- "Remind me at 9pm to do my reviews"
- "Remind me every Monday at 8 to submit my timesheet"
- "Remind me tomorrow morning to call mum"

Reminders can repeat daily, on weekdays, weekly or monthly. Ask "what reminders do I have?" to see them, or "cancel the timesheet reminder".

**Memories.** The bot saves lasting facts about you ("my sister's name is Ploy", "I'm allergic to shrimp") and uses them later.
- Say "remember that…" to save something on purpose.
- Say "forget that…" to remove something.
- Ask "what do you remember about me?" to see the list.

---

## 4. Google: Calendar, Gmail, Tasks, Drive, Docs, Sheets, Contacts

Needs Google connected (SETUP-GUIDE Part 3). Just ask in plain words; the AI uses these:

| Service | What it can do |
|---|---|
| **Calendar** | Lists events from all your calendars (own, shared, family). It can also create, move or delete events: "Put lunch with Ken on Friday at 12". |
| **Gmail** | Searches and reads email, lists unread mail, and writes **drafts**. It never sends email itself, and only drafts to addresses you gave it. |
| **Google Tasks** | Lists, adds and completes tasks. |
| **Drive** | Searches and reads files: Docs, Sheets, PDFs, text. |
| **Docs** | Creates a document or adds to one: "Write my meeting notes into a new doc". |
| **Sheets** | Reads, adds rows, creates spreadsheets: "Add today's expenses to my budget sheet". |
| **Contacts** | Looks up people: "What's Ken's email?" |

---

## 5. Maps and places

Needs `GOOGLE_MAPS_API_KEY`.
- **Places:** `/places ramen near Asok`, or "find a quiet café near me" after sharing your location.
- **Travel time:** "How long to Suvarnabhumi by car at 6pm?" It knows driving, motorbike, walking, cycling and public transport.

---

## 6. News

- `/news` gives a digest of your watchlist (2–3 key stories per topic); `/news <topic>` gives one topic.
- `/topics`, `/addtopic Renewable Energy` and `/removetopic 2` manage the watchlist.
- You can also ask anything current: the AI searches the web and reads pages.

---

## 7. Weather and air quality

- `/weather` gives today's weather and air quality, with advice on umbrellas, masks, UV and what to wear.
- `/forecast` gives 7 days, and `/weekend` plans the weekend around the weather.
- Your city is set by `/setcity`, or by sharing your location; otherwise `WEATHER_CITY` is used.
- **Air quality alert:** if `AQI_ALERT_THRESHOLD` is set (e.g. 100), you get one alert a day when US AQI goes above it.

---

## 8. Briefings and automatic messages

These go to the chats listed in `BOT_NOTIFY_CHATS`. Times are in your time zone; set a time to empty to turn that message off.

| When (default) | Message | Setting |
|---|---|---|
| 07:00 | Weather and air quality | `WEATHER_TIME` |
| 08:00 | **Morning briefing**: weather, today's calendar, important unread email, tasks, news, food diary, money, sleep and steps, WaniKani | `BRIEFING_TIME` |
| 12:00 | Kanji and word of the day | `JAPANESE_TIME` |
| Friday 16:00 | Weekend planner | `WEEKEND_PLANNER_TIME`, `WEEKEND_PLANNER_DAY` |
| 21:00 | Money check: new transactions found in Gmail, budget warnings | `MONEY_CHECK_TIME` |
| 03:00 | Nightly cleanup: old usage logs archived, recent watch days saved to history | `CLEANUP_TIME` |
| Any time | Your reminders | — |
| Hourly | Air quality alert (if over your threshold, once a day) | `AQI_ALERT_THRESHOLD` |
| Hourly | New smart-scale weigh-ins copied into your weight history | — |
| Chosen hour | WaniKani nudge if reviews are waiting (optional) | `BOT_DAILY_NUDGE_HOUR` |

Send `/brief` to get the morning briefing any time.

---

## 9. Money: spending and budgets

### 9.1 Logging spending
- **Send payment slips** from any bank app, PromptPay, เป๋าตัง or e-wallet. Several at once is fine: an album in Telegram or a set of images in LINE becomes one message. For each slip it reads:
  - the date (it converts the Buddhist year, 2569 → 2026) and time
  - the amount you actually paid
  - the shop or person paid
  - the account it came from
  - the reference number
- **Duplicates are skipped:** a slip sent twice, or an email about a payment already logged, isn't counted again.
- **Co-pay schemes** (ไทยช่วยไทย 60/40 and similar): it logs what you paid and notes how much the scheme paid for you.
- **Just tell it:** "haircut 350", "paid the electricity bill 1,240", "salary came in, 45,000".
- **Unclear transfers:** it logs a transfer to a person or company and asks what it was for. Answer ("that was rent") and it fixes the category.
- A slip from a restaurant is **not** added to your food diary unless you ask.

### 9.2 Categories
| Spending | | Income | Not counted as spending |
|---|---|---|---|
| 🍜 food | 🏠 housing | 💼 salary | 🏦 savings (savings, cooperatives, investing) |
| 🛒 groceries | 🛡️ insurance | 💰 income | 🔁 own (between your own accounts) |
| ⛽ transport (fuel, taxi, BTS) | 👪 family (family, gifts, merit) | ↩️ refund | 💳 card_payment (paying the credit card bill) |
| 🛍️ shopping | 🧾 fees (fees, tax, interest) | | |
| 💡 bills (utilities, phone, internet) | ↔️ transfer (to people) | | |
| 🔁 subscriptions | 📦 other | | |
| 💊 health | | | |
| 📚 education | | | |
| 🎬 fun | | | |
| ✈️ travel | | | |

Thai words work in commands too, e.g. `/budget set อาหาร 6000`.

### 9.3 Budgets and reports
- `/budget set 20000` sets the monthly budget; `/budget set food 6000` sets one category.
- `/budget` shows how much you've spent and what's left (with a per-day amount), each category against its limit, income, money moved to savings, and how much co-pay schemes saved you.
- `/budget start 25` makes the budget month run from payday to payday.
- **Warnings** come at 80% and 100% of any budget, once each per month: right after logging, and in the 21:00 check.
- The morning briefing includes yesterday's spending and the month so far.

### 9.4 From your email
- `/budget scan` (or `/budget scan 90`) reads Gmail for:
  - receipts and e-receipts
  - card purchase alerts
  - transfer and bill-payment notices
  - subscription charges
  - salary notices
- It also checks new email every evening at 21:00. Each email is read only once.
- **Limits:** it reads only what's written in the email. Password-protected PDF statements can't be read, and some banks don't email every transfer, so slips remain the main source.

---

## 10. Food diary and body

- **Log food** by telling it ("lunch was khao man gai and a Thai iced tea") or sending a photo. It estimates average calories and macros (Thai portions where relevant) and logs without asking.
- **Packaged food: show the barcode.** Send a photo where the barcode is visible. The bot reads the barcode on the NAS itself (no AI, works offline), then looks the product up:
  1. your own **food database** first;
  2. **Open Food Facts** (a free, open product database, many Thai and Japanese products); anything found is saved to your database;
  3. not found: send a photo of the **nutrition label** (ฉลากโภชนาการ / 栄養成分表示) and it reads and saves it, or it estimates.

  Values are scaled to what you ate (it asks if the portion isn't clear). Correct anything by telling it ("#12 is 220 kcal per pack"); the correction is kept. Foods you log by name ("my usual protein shake") are looked up in your database too.
- `/fooddb` lists your foods, most-logged first; `/export` includes them as `food_database.csv`.
- `/food` shows today against your calorie target. `/food yesterday` and `/food 2026-11-01` show other days; `/food remove 12` deletes an entry.
- **Body profile:** tell it your sex, birth year, height, weight, activity level and goal (lose / maintain / gain). `/profile` shows it.
- `/bmi` gives:
  - BMI, using Asian cut-offs
  - BMR (Mifflin-St Jeor)
  - daily burn
  - a calorie target (you can also set your own)
- **Weight:** `/weight 65.5` logs it. Smart-scale weigh-ins from your watch data are added automatically.
- Health numbers are estimates, not medical advice.

---

## 11. Samsung watch and health history

**Live data.** The Health Sync app uploads Samsung Health data to Google Drive (folders named "Health Sync …"). The bot reads:
- steps
- heart rate and SpO2
- sleep, including stages and score
- calories burned
- workouts
- smart-scale readings

`/health` shows the last days, and the morning briefing includes last night's sleep and yesterday's activity.

**History.** Every synced day is kept in `data/healthdb.json`. Ask about trends: "How has my sleep changed this year?" or "Average steps per month since March?"

**Import years of data:**
1. In Samsung Health, go to **Settings → Download personal data**.
2. Upload the .zip or .rar to Google Drive.
3. Send `/healthimport`. It runs in the background and posts progress; `/healthimport status` checks on it.

On top of the live data types, the import also brings in:
- HRV, breathing rate and stress
- floors climbed and water
- blood pressure
- height (filled into your profile if it's missing)
- food logged in Samsung Health

---

## 12. Japanese: WaniKani, kanji and word of the day

- **`/review`** does your WaniKani reviews right in the chat and submits them to WaniKani.
  - Type answers in kana or romaji (`taberu` works).
  - Small typos in meanings are accepted.
  - `/review 20` sets how many; `/review stop` ends.
- **Kanji / word of the day** (daily at 12:00, or `/kanji` / `/word`): reading, meaning, example words or sentence, a memory trick and a mini quiz.
  - With WaniKani, the items come from your current level, and ones that are due count as reviews.
  - Without WaniKani, they follow your `/jlpt` level and never repeat recent ones.
- Ask anything Japanese: grammar, translations, "what does this sign say?" with a photo. Japanese words come with hiragana readings for learners.
- Practise conversation with `/roleplay` (see below).

---

## 13. Personality, preferences and roleplay

### 13.1 Personality
`/persona` offers ready-made characters, each with a matching voice:
- 💼 Secretary
- 🎩 Butler
- 🌞 Cheerful friend
- 🌸 Caring พี่
- 🎌 Sensei
- 💬 Companion
- 🏋️ Coach

You can also describe your own: `/persona a cheerful Thai older sister who reminds me to drink water and calls me น้อง`.

`/name Mali` renames the bot. The Telegram chat title is set separately, with `/setname` at @BotFather.

### 13.2 Standing preferences
Rules that apply to every reply, in every personality and roleplay:
- `/prefs add Always reply in Thai`
- `/prefs add Use emoji`
- `/prefs` to see them, `/prefs remove 2` to remove one, `/prefs clear` to remove all.
- Or just say "from now on, keep answers short"; the bot saves it itself.
- **WaniKani reviews** use fixed messages (no AI, so they stay free). They switch to Thai when one of your preferences asks for Thai. Answers are still the English meanings WaniKani grades, and its 💡 mnemonics stay in English.
- **All fixed messages** (command replies and buttons, `/budget`, `/food`, `/limit`, alerts, reminders, errors, `/status`) and the Telegram **/** menu also switch to Thai when a preference asks for Thai, without using the AI. Everything the AI writes follows all your preferences.

### 13.3 Roleplay and companion chat
`/roleplay` offers these scenes, or `/roleplay <describe your own>`:
- 🍜 Ramen shop in Tokyo
- 🚉 Lost in Kyoto
- 💼 Job interview in Japanese
- ☕ Café chat
- 🐉 Fantasy adventure
- 🕵️ Detective mystery

In Japanese practice scenes it plays a character and gently corrects your mistakes. It stays in the scene until `/roleplay end`, but still helps at once with real tasks. You can also simply chat with it as a companion about anything.

---

## 14. Voice

- **Voice notes in:** send one in any language. It's transcribed and translated (into English by default; change with `/translate Thai`), then answered. To-dos and reminders you mention are created.
- **Spoken replies:**
  - `/voice notes` (default): answers voice notes with voice
  - `/voice always`: speaks every reply
  - `/voice off`: never speaks
- `/say <text>` speaks anything, which is handy for Japanese pronunciation. To hear a message that is already in the chat, reply to it with `/say` (or just 🔊); `/say` on its own reads my last reply. `/ttsvoice` shows voice buttons; tap one to hear it.
- **A voice per language:** Thai and Japanese can each have their own voice, e.g. Leda for Thai and Autonoe for Japanese, both in your speaking style. Mixed replies switch voice with the language. Set it with `/ttsvoice th …` / `/ttsvoice ja …` or the 🇹🇭 / 🇯🇵 buttons under each `/voices` sample.
- `/voicestyle` sets *how* the voice speaks (mood, pitch, pace), separately from *which* voice. Tap a ready-made style or describe your own in plain words (English works best); it plays a sample right away. You can also just ask, e.g. "make your voice softer and shyer".
- `/voices` plays samples of several female voices one after another (each says a Japanese and a Thai line in a cute style), so you can compare them without testing one by one. Tap your favourite under the samples: it sets the voice and the cute speaking style. About $0.01 of Gemini per round.
- If a voice reply can't be made, the bot says why (e.g. no Gemini speech model on the key, quota used up) instead of staying silent.

---

## 15. AI models, thinking effort and costs

Switch with `/settings` (buttons) or `/model <id>`:

| Model | Good for | Price per 1M tokens (in / out) |
|---|---|---|
| ⚡ `gemini-3.8-flash` (default) | Fast, cheap, everyday | $0.75 / $3.75 |
| 🧠 `gemini-4-argon` | Deep research and planning | $2 / $10 |
| ✍️ `claude-sonnet-5-5` | Writing and email drafting | $2 / $10 |
| 🎯 `claude-opus-5-5` | Most capable, multi-step tasks | $4 / $20 |
| 🪶 `claude-haiku-5-5` | Cheapest Claude | $0.10 / $0.50 |

- **Thinking effort:** `/effort low|medium|high`. Higher effort gives better answers to hard questions but is slower and costs more.
- **Costs:** `/stats` shows usage and cost. Voice transcription and spoken replies always use Gemini.
- **Daily limits (USD).** A warning adds a one-time note to a reply; a cap pauses that AI until midnight.
  - Change them in chat with **`/limit`**. It shows today's spend and the limits, with buttons for common caps:
    - `/limit gemini 3`: cap Gemini at $3 a day
    - `/limit claude warn 1`: warn when Claude passes $1
    - `/limit all 5`: cap all AI together
    - `/limit gemini off`: no Gemini limits
    - `/limit gemini reset` or `/limit reset`: back to the `.env` values
  - Limits set in chat are saved with your settings and override `.env`. In `/limit` they're marked ✏️.
  - The cap for **all AI together** applies on top of the Gemini and Claude caps. If it is lower, it stops replies first; `/limit` warns you when that is the case.
  - Starting values come from `.env`: `GEMINI_DAILY_WARNING_LIMIT_USD` / `GEMINI_DAILY_HARD_LIMIT_USD`, the same for `CLAUDE_…`, and `DAILY_…` for the overall limit.
  - Only you can change limits, with the command. The AI can't change them itself, so nothing in an email or web page can raise them.
- Commands that just look things up (`/todo`, `/food`, `/budget`, `/calendar`, `/inbox`, `/forecast`, `/stats`…) don't use the AI.
- Chat, photos, voice, briefings, `/news`, `/weather`, `/kanji`, `/word`, `/roleplay` and `/budget scan` do.

---

## 16. Your data: where it's kept, backups, export

Everything is stored on **your NAS**, in the `data` folder next to `docker-compose.yml`:

| File | Contents |
|---|---|
| `store.json` | Settings, personality, preferences, conversation history, memories, to-dos, reminders, food diary, body profile, weights, money and budgets, WaniKani review in progress, AI usage log |
| `healthdb.json` | Daily health history (Health Sync + Samsung import) |
| `token.json`, `credentials.json` | Google connection |
| `.env` | Your keys and settings |
| `backups/` | Archived usage logs and copies of your exports |

- **Restarts, NAS reboots and automatic updates keep everything.** Only deleting the `data` folder loses it.
- **Back up** `docker/secretary-bot/data` with Synology Hyper Backup (or snapshots).
- **`/export`** sends a .zip you can open in Excel, Google Sheets or Numbers (Thai text displays correctly). It contains:
  - `food_diary.csv`, `weight.csv`, `health_daily.csv`, `workouts.csv`
  - `samsung_food_log.csv`, `money.csv`, `memories.csv`, `ai_usage.csv`
  - `profile_and_settings.json`

---

## 17. Settings file (.env) reference

Edit `data/.env` on the NAS, then restart the container. Only the first group is required.

| Setting | Default | What it does |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | From @BotFather |
| `TELEGRAM_ALLOWED_USERS` | — | Your Telegram user id(s); everyone else is ignored |
| `GEMINI_API_KEY` | — | Gemini (chat, voice, spoken replies) |
| `ANTHROPIC_API_KEY` | — | Claude models (optional) |
| `BOT_NOTIFY_CHATS` | — | Where briefings and alerts go, e.g. `telegram:12345` |
| `BOT_TIMEZONE` | `Asia/Bangkok` | Your time zone |
| `BOT_NAME` | `Tabi` | The bot's name (or `/name`) |
| `BOT_MODEL` / `BOT_EFFORT` | `gemini-3.8-flash` / `medium` | Starting model and effort |
| `BOT_PERSONA` | — | Extra standing instructions from you |
| `BOT_HISTORY_LIMIT` | `40` | How many recent messages it remembers |
| `BOT_WEB_TOOLS` | `on` | Web search and page reading |
| `BOT_ANNOUNCE_STARTUP` | `on` | "I'm back" message after an update |
| `WEATHER_CITY` | `Bangkok` | Default city |
| `AQI_ALERT_THRESHOLD` | off | Air quality alert level (e.g. `100`) |
| `NEWS_TOPICS` | AI, Global Economy, Thailand | Starting watchlist |
| `NEWS_LANGUAGE` / `NEWS_COUNTRY` | `en-US` / `US` | News edition |
| `BRIEFING_TIME`, `WEATHER_TIME`, `JAPANESE_TIME`, `MONEY_CHECK_TIME`, `CLEANUP_TIME` | 08:00, 07:00, 12:00, 21:00, 03:00 | Daily message times (empty = off) |
| `WEEKEND_PLANNER_TIME` / `WEEKEND_PLANNER_DAY` | `16:00` / `fri` | Weekend planner |
| `BOT_DAILY_NUDGE_HOUR` | off | Hour for a WaniKani "reviews waiting" nudge |
| `WANIKANI_TOKEN` | — | WaniKani (needs the `reviews:create` permission for `/review`) |
| `GOOGLE_MAPS_API_KEY` | — | Places and travel times |
| `data/vertex-key.json` + `VERTEX_LOCATION`, `VERTEX_PROJECT`, `GEMINI_VIA_VERTEX` | off until the key file is there | Run Gemini through Vertex AI so Google Cloud credit pays for it (SETUP-GUIDE Part 6); the Gemini API key stays as backup |
| `VOICE_TRANSLATE_TO` | `English` | Voice note translation language |
| `VOICE_REPLIES` | `voice-notes` | `off`, `voice-notes` or `always` |
| `TTS_VOICE` | `Kore` | Speaking voice |
| `GEMINI_…` / `CLAUDE_…` / `DAILY_…` `_WARNING_LIMIT_USD` / `_HARD_LIMIT_USD` | off | Starting daily cost limits (change in chat with `/limit`) |
| `LOG_RETENTION_DAYS` | `30` | Days of usage log kept before archiving |
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_ALLOWED_USERS` | — | LINE (optional) |
| `PUBLIC_URL` | — | Public address, needed for LINE and LINE file links |

---

## 18. Privacy and safety

- **Only you can use it:** messages from anyone not in `*_ALLOWED_USERS` are ignored.
- **Your data stays on your NAS.** Messages go to the AI provider you chose (Google or Anthropic) only to get an answer.
- **Email is treated as untrusted:**
  - The bot never follows instructions written inside emails.
  - It only creates Gmail drafts; it never sends.
  - Money emails are read by an AI step that cannot take any actions.
- The GitHub repository is public, but it contains only code. Your `.env`, `data/` and Google files are never uploaded.

---

## 19. Troubleshooting

| Problem | Try |
|---|---|
| The bot doesn't answer | `/status`; check the container is running in Container Manager; check your id is in `TELEGRAM_ALLOWED_USERS` (`/id`). |
| "Google is not connected" | Run `npm run google-auth` again on your computer and copy the new `token.json` to `data/`. |
| A feature says a key is missing | Add the key to `data/.env` and restart the container. |
| "Daily limit reached" | A cost cap was hit; it resets at midnight, or raise it now with `/limit` (e.g. `/limit gemini 1`). |
| Still blocked after raising the Gemini or Claude cap | The **all AI together** cap (from `DAILY_HARD_LIMIT_USD` in `.env`) also applies. The block message says which cap stopped it; send `/limit all 5` or `/limit all off`. |
| "too many voice requests in a minute" | Gemini's speech model allows only a few requests per minute. The bot already waits and retries; if it still happens, wait a minute and try again. It is not your credit. |
| No voice, or "🔇 I couldn't make the voice reply" | The message gives the reason. Voice uses Gemini (GEMINI_API_KEY) even when chatting with Claude. Try `/say hello`; `/status` shows the speech model in use. |
| A slip or food was logged wrong | Tell it ("that was rent, not transfer"), or use `/budget edit`, `/budget remove`, `/food remove`. |
| Health import shows 0 days | Send the import report to the developer; it lists the columns found in each file. |
| It's "typing" for a long time | Big jobs (health import, email scan, long research) take a minute or two; `/healthimport status` shows import progress. |
