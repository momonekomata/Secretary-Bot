# Beginner setup guide (step by step)

This guide assumes you have never run a program like this before. Go slowly and do one part at a time.

1. **Part 1 — Telegram** on your computer (about 20 minutes). Start here.
2. **Part 2 — Morning briefings** and alerts (5 minutes).
3. **Part 3 — Connect Google** Calendar, Gmail, Tasks, Drive, Docs, Sheets, Contacts and Maps (about 20 minutes).
4. **Part 4 — Run it 24/7 on your NAS** with Docker, with automatic updates.
5. **Part 5 — LINE** (optional).

**What it costs:** Telegram and LINE are free. Gemini has a free tier for Gemini 3.8 Flash; past that, and for Gemini 4 Argon and
Claude, you pay per use. The bot tracks its own spending (`/stats`) and can warn you and pause itself at a daily limit.

**Words you'll see:**
- **Terminal**: a window where you type commands instead of clicking. You type a command, press **Enter**, and it runs.
- **Token / key**: a long password-like code that lets the bot use a service. Treat each one like a password: never post it anywhere.

---

## Part 1 — Telegram (about 20 minutes)

### Step 1. Install Node.js (the program that runs the bot)

1. Go to **https://nodejs.org** and download the version marked **LTS**.
2. Open the downloaded file and click **Next / Continue** until it finishes. Keep all the default options.
3. Check it worked: open a terminal.
   - **Windows:** press the **Start** button, type `cmd`, and open **Command Prompt**.
   - **Mac:** press **⌘ Command + Space**, type `Terminal`, and press **Enter**.
4. Type this and press **Enter**:
   ```
   node --version
   ```
   You should see something like `v22.11.0`. If you see "not recognized" or "command not found", restart your computer and try again.

### Step 2. Download the bot

1. Open this link. It downloads a ZIP file:
   **https://github.com/momonekomata/Secretary-Bot/archive/refs/heads/main.zip**
2. Unzip it. **Windows:** right-click the ZIP → **Extract All** → **Extract**. **Mac:** double-click it.
3. You now have a folder named **`Secretary-Bot-main`**. Move it somewhere easy, such as **Documents**. This is the bot's folder.

### Step 3. Get your Gemini API key

1. Go to **https://aistudio.google.com/apikey** and sign in with your Google account.
2. Click **Create API key** and copy the key into a note.
3. *(Optional)* To also use **Claude**: sign up at **https://platform.claude.com**, add credits under **Billing**,
   then **API keys** → **Create key**, and copy it (it starts with `sk-ant-`). You can add this later.

### Step 4. Create your Telegram bot

1. Install **Telegram** on your phone or computer and sign in.
2. In Telegram's search bar, search for **@BotFather** (it has a blue check mark) and open it. Press **Start**.
3. Send `/newbot`.
4. It asks for a **name**. Type anything, for example `Tabi`.
5. It asks for a **username**. This must end in `bot` and nobody else can be using it, for example `tabi_parinya_bot`.
6. BotFather replies with a **token** that looks like `7012345678:AAH...`. Copy it into your note.

### Step 5. Open a terminal inside the bot's folder

- **Windows:** open the `Secretary-Bot-main` folder in File Explorer. Click the **address bar** at the top (where the folder path is), type `cmd`,
  and press **Enter**. A black window opens, already in the right folder.
- **Mac:** open Terminal, type `cd ` (with a space after it, don't press Enter yet), then **drag the `Secretary-Bot-main` folder from Finder into the
  Terminal window**. Its path appears. Now press **Enter**.

Check you're in the right place: type `npm run` and press Enter. You should see a list that includes `setup` and `start`.

### Step 6. Install the bot's parts

```
npm install
```
It downloads what the bot needs and can take a minute. Warnings in yellow are normal. Wait until you can type again.

### Step 7. Enter your keys

```
npm run setup
```
It asks a few questions. Paste the answer to each and press **Enter**.
(To paste in a terminal: **Windows** right-click, or Ctrl+V. **Mac** ⌘ Command+V.)
Press **Enter** alone to accept the value shown in `[brackets]`.

| Question | What to type |
|---|---|
| Gemini API key | your key from Step 3 |
| Claude API key | your `sk-ant-...` key, or press Enter to skip |
| Bot name, time zone, city | press Enter to keep `Tabi`, `Asia/Bangkok`, `Bangkok`, or type your own |
| Telegram bot token | the token from BotFather |
| Your Telegram user id | **press Enter**: you don't know it yet, the bot will tell you |
| LINE channel secret | **press Enter** to skip for now |
| Chat for morning briefings | **press Enter** for now (Part 2) |
| Daily spend warning / hard cap | press Enter to keep $0.50 and $1.50, or type your own |
| WaniKani API token | paste it if you have one (wanikani.com → Settings → API Tokens), or press Enter |

### Step 8. Start the bot and get your user id

```
npm start
```
You should see `Telegram: polling as @your_bot_name`. **Leave this window open**: the bot only runs while it is open.

In Telegram, search for your bot's username, open it, and press **Start**. It replies:
*"This bot is not set up yet. Your Telegram user id is 123456789…"*. Copy that number.

### Step 9. Tell the bot it's you

1. In the terminal, press **Ctrl + C** to stop the bot. If it asks "Terminate batch job?", type `Y` and press Enter.
2. Run `npm run setup` again. Press **Enter** to keep each value you already gave, and when it asks for **Your Telegram user id**,
   paste the number.
3. Run `npm start` again.

### Step 10. Try it 🎉

- `/help` shows everything it can do. Tap the **/** button in Telegram for the command menu.
- `/settings` lets you switch between Gemini and Claude, and set how hard it thinks, with buttons.
- `/news` gives you a news briefing; `/weather` today's weather and air quality; `/weekend` a weekend planner.
- `/add Call the dentist` and `/todo` manage a to-do list.
- Hold the 🎤 button and **send a voice note** (in Thai, English or Japanese): it transcribes it, translates it, summarises it,
  and creates any to-dos or reminders you mention.
- Send a photo of Japanese text and ask "what does this say?"
- Send a **PDF, Word file or text file** and ask about it ("what's the total on this invoice?").
- Tap 📎 → **Location** to share where you are: weather and nearby places use it.
- `Remind me in 10 minutes to drink water`, or `Remind me every weekday at 9 to check email` (repeating).
- `/voice always` makes it answer with a spoken voice message too (`/voice off` to stop, `/say สวัสดี` to hear something).
  Spoken replies need the free **ffmpeg** program on your computer (Mac: `brew install ffmpeg`; Windows: `winget install ffmpeg`).
  It is already included on the NAS (Part 4).

**Each time you want to use the bot later:** open a terminal in the `Secretary-Bot-main` folder (Step 5) and run `npm start`.
To keep it running all the time, see Part 4.

---

## Part 2 — Morning briefings and alerts (5 minutes)

The bot can message you on its own: weather at **07:00**, a full morning briefing at **08:00** (weather, calendar, unread email,
tasks, news, WaniKani), a weekend planner on **Fridays at 16:00**, and spending and air-quality alerts.

1. In Telegram, send `/id` to your bot. It shows **This chat: telegram:123456789**. Copy that `telegram:…` text.
2. Stop the bot (**Ctrl + C**), run `npm run setup`, and paste it at **Chat for morning briefings**. Start the bot again.
3. Choose your news: `/topics` shows the list, `/addtopic Renewable Energy` adds one, `/removetopic 2` removes the second.
4. Set your city: `/setcity Chiang Mai`.
5. Try them now without waiting: `/brief`, `/weather`, `/weekend`.

Change the times in `.env` (`WEATHER_TIME`, `BRIEFING_TIME`, `WEEKEND_PLANNER_TIME`; leave one empty to turn it off).
`/status` shows what's connected and when each message is scheduled.

---

## Part 3 — Connect Google (Calendar, Gmail, Tasks, Drive, Docs, Sheets, Contacts, Maps)

This lets the bot:
- **Calendar**: see all your calendars (including shared and family ones), add, move, change and delete events.
- **Gmail**: read and search all your mail ("what did Ken say about the contract last week?") and write **drafts**.
  It never sends email itself; drafts wait in Gmail for you to check and send.
- **Tasks**: list, add and tick off Google Tasks (`/gtask`, `/gdone 2`).
- **Drive**: find files and read them (Google Docs, Sheets, Slides, PDFs, Word).
- **Docs and Sheets**: create documents ("write up these meeting notes as a Google Doc") and add rows ("log 120 baht lunch in my expenses sheet").
- **Contacts**: look up email addresses and phone numbers, so "draft an email to Ken" finds Ken.

**Google Keep can't be connected**: Google only offers its Keep API to company (Workspace) accounts, not personal Gmail.
Use Google Tasks or a Google Doc for notes instead.

> **Already connected Google before?** The bot now asks for a few more permissions. Do Step 11.3 (enable the new APIs) and Step 14 (sign in again);
> `/status` tells you if anything is still missing.

### Step 11. Create a Google Cloud project

1. Go to **https://console.cloud.google.com** and sign in. Accept the terms if asked.
2. At the top, click the project picker → **New project**. Name it `Secretary Bot` → **Create**. Make sure it is selected at the top.
3. Turn on the four APIs. Open each link below, check that your project is selected, and click **Enable**:
   - https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   - https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - https://console.cloud.google.com/apis/library/tasks.googleapis.com
   - https://console.cloud.google.com/apis/library/drive.googleapis.com
   - https://console.cloud.google.com/apis/library/docs.googleapis.com
   - https://console.cloud.google.com/apis/library/sheets.googleapis.com
   - https://console.cloud.google.com/apis/library/people.googleapis.com (Contacts)

   *(If you have the `gcloud` tool installed, `npm run setup-gcp` does this step for you.)*

### Step 12. Set up the sign-in screen

Google renames these pages from time to time; look for the closest match.

1. Open **https://console.cloud.google.com/auth/overview** → **Get started**.
2. App name `Secretary Bot`, your email for support → **Next**. Audience: **External** → **Next**. Your email again → **Next** → agree → **Create**.
3. Go to **Audience** → **Test users** → **Add users** → add your own Gmail address → **Save**.
4. Still on **Audience**, click **Publish app** → **Confirm** (status becomes **In production**).
   Your app stays unverified, which is fine for personal use. Without this step, Google signs the bot out every 7 days.

### Step 13. Download the client file

1. Open **https://console.cloud.google.com/auth/clients** → **Create client**.
2. Application type: **Desktop app**. Name: `Secretary Bot` → **Create**.
3. Click **Download JSON**. Rename the file to **`credentials.json`**.
4. In the `Secretary-Bot-main` folder, open the **`data`** folder (it was created when you first ran the bot) and put `credentials.json` inside.

### Step 14. Sign in

1. Stop the bot (**Ctrl + C**) and run:
   ```
   npm run google-auth
   ```
2. It prints a long link. Open it in your browser and sign in with the Gmail address you added as a test user.
3. Google warns **"Google hasn't verified this app"**: click **Advanced** → **Go to Secretary Bot (unsafe)**. It's your own app.
4. Tick all the permissions and click **Continue**. The terminal says **✅ Google connected**.
   (If the browser instead shows "This site can't be reached", copy the whole address from the address bar, paste it into the terminal, and press Enter.)
5. Start the bot again with `npm start`.

Try `/calendar`, `/inbox`, `/mail from:ken contract`, `/gtask`, or just ask: *"Do I have time for a dentist appointment tomorrow afternoon?"*,
*"Move my dentist appointment to 5pm"*, *"Draft an email to Ken about the Q4 deck"* or *"Summarise the budget doc in my Drive."*
Voice notes like *"add a meeting with Ken on Friday at 3"* go straight into Google Calendar and Google Tasks.

### Step 15 (optional). Google Maps: nearby places and travel times

Maps works differently: it needs an **API key** and a **billing account** on your Google Cloud project (Google gives a monthly free
allowance; a personal bot rarely goes past it, but Google requires a card).

1. Add billing: https://console.cloud.google.com/billing → link a billing account to the `Secretary Bot` project.
2. Enable **Places API (New)** and **Routes API**:
   https://console.cloud.google.com/apis/library/places.googleapis.com and https://console.cloud.google.com/apis/library/routes.googleapis.com
3. https://console.cloud.google.com/apis/credentials → **Create credentials** → **API key**. Copy it.
   (Recommended: **Edit API key** → **API restrictions** → restrict it to those two APIs.)
4. `npm run setup` → paste it at **Google Maps API key**. Restart the bot.

Then try `/places ramen near Asok`, or *"How long to Don Mueang airport by car right now?"*

---

## Part 4 — Run it 24/7 on your NAS (Docker)

On the NAS the bot runs as a **Docker container**. A second container, **Watchtower**, updates it automatically whenever new code
reaches GitHub: each push to the `main` branch builds a new image (GitHub Actions), and Watchtower installs it within about 5 minutes.
The bot then messages you "✅ updated and running".

### Step 16. Prepare on your computer

Do Parts 1–3 on your computer first, so that the `data` folder holds your `.env` (written by `npm run setup`), `credentials.json`
and `token.json`. Stop the bot on your computer afterwards: only one copy should run at a time.

### Step 17. Make the image downloadable (once)

GitHub publishes the image after code reaches the `main` branch. The first time, it's private. Make it public (it contains no keys):
on GitHub open your profile → **Packages** → **secretary-bot** → **Package settings** → **Change visibility** → **Public**.

### Step 18. Set up the folder on the NAS

1. On the NAS (e.g. Synology **File Station**), create a folder such as `docker/secretary-bot`.
2. Upload **`docker-compose.yml`** (from the `Secretary-Bot-main` folder) into it.
3. Create a folder **`data`** inside it and upload your **`.env`**, **`credentials.json`** and **`token.json`** into `data`.
   (`.env` is a hidden file on Mac: in Finder press **⌘ Shift .** to show it.)
4. If your time zone isn't Bangkok, open `docker-compose.yml` and change both `TZ=Asia/Bangkok` lines.

### Step 19. Start it

- **Synology:** open **Container Manager** → **Project** → **Create**. Name `secretary-bot`, path: the `docker/secretary-bot` folder.
  It finds `docker-compose.yml` → **Next** → **Done**. Both containers start.
- **Other NAS (QNAP, Unraid, Portainer) or SSH:** in that folder run `docker compose up -d`.

Send `/status` to your bot from Telegram to check everything is connected. The containers restart by themselves if the NAS reboots.

---

## Part 5 — LINE (optional, harder)

LINE sends messages to the bot over the internet, so the bot needs a public web address. For testing, a free tool called
**cloudflared** gives your computer a temporary one.

> LINE renames its buttons from time to time. If a button below has a slightly different name, look for the closest match.

### Step 20. Create a LINE Official Account with the Messaging API

1. Go to **https://developers.line.biz/console/** and log in with your LINE account.
2. Create a **Provider** (any name, e.g. your own name).
3. Create a **LINE Official Account** for the bot. LINE does this in **LINE Official Account Manager** (the console links you there).
4. In **LINE Official Account Manager**, open **Settings** → **Messaging API** → **Enable Messaging API**, and pick the provider you made.
5. In Official Account Manager open **Response settings** and turn **Auto-response messages** **off** and **Webhook** **on**.

### Step 21. Copy the two LINE keys

Back in the **LINE Developers console**, open your provider → your channel:
- **Basic settings** tab → copy **Channel secret**.
- **Messaging API** tab → **Channel access token (long-lived)** → **Issue** → copy it.

Stop the bot (**Ctrl + C**), run `npm run setup`, keep the old answers, and paste these two. Leave **Your LINE user id** empty. Run `npm start`.

### Step 22. Try it with a temporary address

1. Open a **second** terminal and run `npx cloudflared tunnel --url http://localhost:8787`. Copy the `https://….trycloudflare.com` address it prints.
2. LINE Developers console → **Messaging API** tab → **Webhook URL** → **Edit** → paste the address with `/line` at the end → **Update** → **Verify** (should say Success) → turn on **Use webhook**.
3. Scan the **QR code** on that page with LINE, add the bot as a friend, and send it a message. It replies with your LINE user id (starts with `U`).
4. **Ctrl + C** in the first terminal, `npm run setup` (paste the id), `npm start`.

The cloudflared address changes every time you start it, so this is only for trying LINE out.

### Step 23. A permanent address on the NAS

With a permanent address the bot also connects the LINE webhook **by itself**, and can send **spoken replies** and the nightly
backup file in LINE (as links). Pick one option:

**Option A — Tailscale Funnel (free, no domain needed)**
1. Create a free account at **https://tailscale.com**.
2. On the NAS install Tailscale (Synology: **Package Center** → search **Tailscale** → Install) and sign in.
3. Turn on Funnel: in the Tailscale admin console (**https://login.tailscale.com/admin**) → **Access controls**, allow Funnel
   (the page offers a button to add it), and under **DNS** enable **HTTPS certificates**.
4. SSH into the NAS and run `tailscale funnel --bg 8787`. It prints an address like `https://my-nas.tail1234.ts.net`.

**Option B — Cloudflare Tunnel (if you own a domain on Cloudflare)**
1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** (Cloudflared). Copy the token.
2. Add a **public hostname**, e.g. `bot.yourdomain.com`, pointing to `http://secretary-bot:8787`.
3. In `docker-compose.yml`, uncomment the `cloudflared` service and paste the token. Restart the project.

**Then, for either option:** add `PUBLIC_URL=https://your-address` (no `/line` at the end) to `data/.env` on the NAS, and restart the
`secretary-bot` container. Check with `/status` (it shows the public address) and send the bot a message in LINE.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| `'node' is not recognized` / `command not found: node` | Node.js isn't installed, or the terminal was opened before installing. Restart the computer and try again. |
| `npm ERR! enoent ... package.json` | The terminal isn't in the `Secretary-Bot-main` folder. Redo Step 5. |
| Windows: `running scripts is disabled on this system` | You're in PowerShell. Use **Command Prompt** instead (type `cmd` in the folder's address bar). |
| The bot doesn't answer in Telegram | Is the bot running? Is your user id in setup? Send `/id`, then `/status`. |
| "My AI API key was rejected" | Run `npm run setup` and paste the key again. |
| "The selected model … needs ANTHROPIC_API_KEY" | You picked a Claude model without a Claude key. Pick a Gemini model in `/settings`, or add the key. |
| "Daily spending cap reached" | The bot paused itself to protect your wallet. It unlocks at midnight, or raise `DAILY_HARD_LIMIT_USD`. |
| Voice notes: "need a Gemini API key" | Voice notes always use Gemini. Add `GEMINI_API_KEY` with `npm run setup`. |
| "Google sign-in has expired" | Run `npm run google-auth` again (and make sure you did Step 12.4, Publish app). On the NAS, copy the new `token.json` into `data`. |
| `/status` says a Gemini model isn't available | Google may have renamed it. Pick another model in `/settings`. |
| "Google needs one more permission" / `/status` lists missing Google features | Enable the APIs in Step 11.3, then run `npm run google-auth` again. |
| No spoken reply, or LINE voice messages fail | Spoken replies and LINE voice need ffmpeg (included on the NAS; on your computer install it, see Step 10). In LINE they also need `PUBLIC_URL` (Step 23). |
| "I can't read … yet" for a file | PDFs, Word (.docx), text and CSV files and images work. For Excel files, upload to Google Sheets and ask about it there. |
| Maps says `REQUEST_DENIED` or 403 | Billing isn't linked, or Places API (New) / Routes API isn't enabled for the key (Step 15). |
| `Error: listen EADDRINUSE :8787` | The bot is already running in another window. Close it, or press Ctrl + C there. |
| NAS: `pull access denied` / `unauthorized` for ghcr.io | Do Step 17 (make the package public), or check the GitHub Actions run finished. |
| NAS: briefings arrive at the wrong hour | Set `TZ` in `docker-compose.yml` and `BOT_TIMEZONE` in `.env` to your time zone. |
| LINE **Verify** fails | Both the bot and cloudflared must be running, and the URL must end in `/line`. |

If you're stuck, copy the red error text from the terminal (**without** any keys in it) and ask for help.
