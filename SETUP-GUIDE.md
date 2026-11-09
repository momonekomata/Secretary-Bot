# Beginner setup guide (step by step)

This guide assumes you have never run a program like this before. Go slowly and do one step at a time.
Start with **Telegram**: it is the easiest. Add LINE later if you want it (Part 2).

**What it costs:** Telegram and LINE are free. Claude is pay-as-you-go: you buy credits (from about US$5) and each message
uses a little. You can see your usage at any time on the Claude website.

**Words you'll see:**
- **Terminal**: a window where you type commands instead of clicking. You type a command, press **Enter**, and it runs.
- **Folder path**: where a folder is on your computer.
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

### Step 3. Get your Claude API key

1. Go to **https://platform.claude.com** and sign up or log in.
2. Open **Billing** (in Settings) and buy credits. US$5 is plenty to start.
3. Open **API keys** → **Create key**. Give it a name, such as `my bot`.
4. **Copy the key now** (it starts with `sk-ant-`) and paste it into a note for a moment. The site shows it only once.

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

Type this and press **Enter**. It downloads what the bot needs, and can take a minute:
```
npm install
```
Warnings in yellow are normal. Wait until you can type again.

### Step 7. Enter your keys

```
npm run setup
```
It asks a few questions. Paste the answer to each and press **Enter**.
(To paste in a terminal: **Windows** right-click, or Ctrl+V. **Mac** ⌘ Command+V.)

| Question | What to type |
|---|---|
| Claude API key | your `sk-ant-...` key |
| Bot name | press Enter to keep `Tabi`, or type a name |
| Your time zone | press Enter to keep `Asia/Bangkok`, or type yours, e.g. `Asia/Tokyo` |
| Telegram bot token | the token from BotFather |
| Your Telegram user id | **press Enter**: you don't know it yet, the bot will tell you |
| LINE channel secret | **press Enter** to skip for now |
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

Send your bot messages like:
- `สวัสดี! Teach me 3 Japanese words about food`
- `Remember that my JLPT N4 exam is on 6 December`
- `Remind me in 10 minutes to drink water`
- Send a photo of Japanese text and ask "what does this say?"
- `How many WaniKani reviews do I have?` (if you added a WaniKani token)

**Each time you want to use the bot later:** open a terminal in the `Secretary-Bot-main` folder (Step 5) and run `npm start`.

---

## Part 2 — LINE (optional, harder, about 30 minutes)

LINE sends messages to the bot over the internet, so your bot needs a public web address. For testing, a free tool called
**cloudflared** gives your computer a temporary one.

> I couldn't check LINE's website while writing this, and LINE renames its buttons from time to time.
> If a button below has a slightly different name, look for the closest match.

### Step 11. Create a LINE Official Account with the Messaging API

1. Go to **https://developers.line.biz/console/** and log in with your LINE account.
2. Create a **Provider** (any name, e.g. your own name).
3. Create a **LINE Official Account** for the bot. LINE now does this in **LINE Official Account Manager**
   (the console links you there). Fill in the account name and category.
4. In **LINE Official Account Manager**, open **Settings** → **Messaging API** → **Enable Messaging API**, and pick the provider you made.
5. Turn off LINE's own automatic answers: in Official Account Manager open **Response settings** (or **Settings → Response**)
   and turn **Auto-response messages** (also called auto-reply) **off** and **Webhook** **on**.

### Step 12. Copy the two LINE keys

Back in the **LINE Developers console**, open your provider → your channel:
- **Basic settings** tab → copy **Channel secret**.
- **Messaging API** tab → scroll to **Channel access token (long-lived)** → **Issue** → copy it.

Stop the bot (**Ctrl + C**), run `npm run setup`, press Enter to keep the old answers, and paste these two when it asks.
Leave **Your LINE user id** empty for now. Then run `npm start`.

### Step 13. Give the bot a public address

Open a **second** terminal window (keep the bot running in the first) and run:
```
npx cloudflared tunnel --url http://localhost:8787
```
After a few seconds it prints an address like `https://some-random-words.trycloudflare.com`. Copy it.
Keep this window open too.

### Step 14. Connect LINE to the bot

1. LINE Developers console → your channel → **Messaging API** tab → **Webhook URL** → **Edit**.
2. Paste your address and add `/line` at the end, for example:
   `https://some-random-words.trycloudflare.com/line` → **Update**.
3. Click **Verify**. It should say **Success**.
4. Turn on **Use webhook**.

### Step 15. Get your LINE user id and finish

1. On the same **Messaging API** tab there is a **QR code**. Scan it with LINE on your phone and add the bot as a friend.
2. Send it any message. It replies with your LINE user id (starts with `U`). Copy it.
3. In the first terminal: **Ctrl + C**, `npm run setup` (paste the id at **Your LINE user id**), then `npm start`.

Now the bot answers you in LINE too.

**Note:** the cloudflared address changes every time you start it, so you'd need to repeat Step 14 each time.
That's fine for trying it out. To have LINE work all the time, see Part 3.

---

## Part 3 — Keeping it on all the time (later)

The bot stops when you close the terminal or your computer sleeps. When you're happy with it, you can move it to a machine that's
always on: an old laptop, a Raspberry Pi, or a small cloud server (a VPS, Fly.io, or Railway). `README.md` has the technical
details (a Docker image is included). Ask for help when you get there; it's a separate project.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| `'node' is not recognized` / `command not found: node` | Node.js isn't installed, or the terminal was opened before installing. Restart the computer and try again. |
| `npm ERR! enoent ... package.json` | The terminal isn't in the `Secretary-Bot-main` folder. Redo Step 5. |
| Windows: `running scripts is disabled on this system` | You're in PowerShell. Use **Command Prompt** instead (type `cmd` in the folder's address bar). |
| The bot doesn't answer in Telegram | Is the terminal still open and running `npm start`? Is your user id in setup? Send `/id` to check. |
| Bot says "My Claude API key was rejected" | Run `npm run setup` and paste the key again (it starts with `sk-ant-`). |
| Bot says it's "rate limited" or "Something went wrong" | Check you have credits left at platform.claude.com → Billing. Then look at the terminal for the error message. |
| `Error: listen EADDRINUSE :8787` | The bot is already running in another window. Close the other window, or press Ctrl + C there. |
| LINE **Verify** fails | Both terminals (bot and cloudflared) must be running, and the URL must end in `/line`. |
| LINE answers with its own canned message | Turn off auto-response in Official Account Manager (Step 11.5). |

If you're stuck, copy the red error text from the terminal (**without** any keys in it) and ask for help.
