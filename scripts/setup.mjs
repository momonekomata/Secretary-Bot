// Interactive helper: asks for each setting and writes .env.
// Run with `npm run setup`. Run it again any time; press Enter to keep a value.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

const FILE = '.env';
const env = {};
if (existsSync(FILE)) {
  for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "");
  }
}

const QUESTIONS = [
  ['GEMINI_API_KEY', 'Gemini API key from Google AI Studio (main AI, also needed for voice notes)', { secret: true }],
  ['ANTHROPIC_API_KEY', 'Claude API key, starts with sk-ant- (optional: lets you switch to Claude in /settings)', { secret: true }],
  ['BOT_NAME', 'Bot name', { def: 'Tabi' }],
  ['BOT_TIMEZONE', 'Your time zone', { def: 'Asia/Bangkok' }],
  ['WEATHER_CITY', 'Your city for weather reports', { def: 'Bangkok' }],
  ['TELEGRAM_BOT_TOKEN', 'Telegram bot token from @BotFather (Enter to skip Telegram)', { secret: true }],
  ['TELEGRAM_ALLOWED_USERS', 'Your Telegram user id (Enter if you do not know it yet; the bot will tell you)', { onlyIf: 'TELEGRAM_BOT_TOKEN' }],
  ['LINE_CHANNEL_SECRET', 'LINE channel secret (Enter to skip LINE)', { secret: true }],
  ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE channel access token', { secret: true, onlyIf: 'LINE_CHANNEL_SECRET' }],
  ['LINE_ALLOWED_USERS', 'Your LINE user id, starts with U (Enter if you do not know it yet)', { onlyIf: 'LINE_CHANNEL_SECRET' }],
  ['PUBLIC_URL', 'Public https address of the bot, for LINE (Enter to skip; see SETUP-GUIDE.md Part 5)', { onlyIf: 'LINE_CHANNEL_SECRET' }],
  ['GOOGLE_MAPS_API_KEY', 'Google Maps API key for places and travel times (Enter to skip)', { secret: true }],
  ['BOT_NOTIFY_CHATS', 'Chat for morning briefings and alerts, from /id, e.g. telegram:123456789 (Enter to skip for now)', {}],
  ['GEMINI_DAILY_WARNING_LIMIT_USD', 'Gemini: daily spend warning, in US dollars', { def: '0.20', onlyIf: 'GEMINI_API_KEY' }],
  ['GEMINI_DAILY_HARD_LIMIT_USD', 'Gemini: daily hard cap, in US dollars (Gemini pauses until midnight)', { def: '0.30', onlyIf: 'GEMINI_API_KEY' }],
  ['CLAUDE_DAILY_WARNING_LIMIT_USD', 'Claude: daily spend warning, in US dollars', { def: '2.50', onlyIf: 'ANTHROPIC_API_KEY' }],
  ['CLAUDE_DAILY_HARD_LIMIT_USD', 'Claude: daily hard cap, in US dollars (Claude pauses until midnight)', { def: '3.00', onlyIf: 'ANTHROPIC_API_KEY' }],
  ['WANIKANI_TOKEN', 'WaniKani API token (Enter to skip)', { secret: true }],
];

const mask = (v) => (v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '****');
const rl = createInterface({ input, terminal: false });
const lines = rl[Symbol.asyncIterator]();
async function ask(prompt) {
  output.write(prompt);
  const next = await lines.next();
  if (next.done) throw new Error('Input ended before setup finished.');
  return next.value;
}
console.log('\nBot setup. Paste each value and press Enter. Press Enter alone to keep the value in [brackets]; type none to clear it.\n');

for (const [key, label, opt] of QUESTIONS) {
  if (opt.onlyIf && !env[opt.onlyIf]) continue;
  const current = env[key] || opt.def || '';
  const shown = current ? ` [${opt.secret ? mask(current) : current}]` : '';
  for (;;) {
    const answer = (await ask(`${label}${shown}: `)).trim().replace(/^["']|["']$/g, '');
    const value = answer.toLowerCase() === 'none' ? '' : answer || current;
    if (opt.required && !value) {
      console.log('  This one is required.');
      continue;
    }
    env[key] = value;
    break;
  }
}
rl.close();

if (!env.GEMINI_API_KEY && !env.ANTHROPIC_API_KEY) {
  console.log('\nNote: you gave no AI key, so the bot cannot think yet. Run `npm run setup` again to add GEMINI_API_KEY.');
}
if (!env.TELEGRAM_BOT_TOKEN && !env.LINE_CHANNEL_SECRET) {
  console.log('\nNote: you skipped both Telegram and LINE, so the bot has nowhere to chat yet. Run `npm run setup` again to add one.');
}
const body = Object.entries(env)
  .filter(([, v]) => v !== '')
  .map(([k, v]) => `${k}=${v}`)
  .join('\n');
writeFileSync(FILE, `# Written by npm run setup. Keep this file secret.\n${body}\n`);
console.log(`\nSaved to ${FILE}. Now start the bot with:  npm start\n`);
