# Secretary Bot — privacy policy

Secretary Bot is a personal assistant that one person runs for themselves, on their own computer or NAS.
It is not a public service: it only answers the Telegram and LINE accounts its owner lists in its settings.

## What it accesses

When its owner connects a Google account, the bot can read and change that account's Google Calendar events,
read and search Gmail and create drafts (it never sends email), manage Google Tasks, read Google Drive files,
create and edit Google Docs and Sheets, and look up Google Contacts. It does this only when its owner asks, or
for the scheduled briefings its owner turned on.

## Where data goes

- Data is processed on the owner's own machine. Conversations, settings, reminders, usage logs and the Google
  sign-in token are stored only in the bot's data folder there.
- To answer a request, the relevant text (for example an email or calendar entry the owner asked about) is sent to
  the AI service the owner selected (Google Gemini or Anthropic Claude), under that provider's terms.
- Nothing is sold, shared with anyone else, or used for advertising.

## Removing access

The owner can disconnect the bot at any time at https://myaccount.google.com/permissions, and delete the bot's
data folder to remove everything it stored.

## Contact

Questions: open an issue at https://github.com/momonekomata/Secretary-Bot/issues.
