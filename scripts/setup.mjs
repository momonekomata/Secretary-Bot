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
    if (m) env[m[1]] = m[2];
  }
}

const QUESTIONS = [
  ['ANTHROPIC_API_KEY', 'Claude API key (starts with sk-ant-)', { secret: true, required: true }],
  ['BOT_NAME', 'Bot name', { def: 'Tabi' }],
  ['BOT_TIMEZONE', 'Your time zone', { def: 'Asia/Bangkok' }],
  ['TELEGRAM_BOT_TOKEN', 'Telegram bot token from @BotFather (Enter to skip Telegram)', { secret: true }],
  ['TELEGRAM_ALLOWED_USERS', 'Your Telegram user id (Enter if you do not know it yet; the bot will tell you)', {}],
  ['LINE_CHANNEL_SECRET', 'LINE channel secret (Enter to skip LINE)', { secret: true }],
  ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE channel access token', { secret: true, onlyIf: 'LINE_CHANNEL_SECRET' }],
  ['LINE_ALLOWED_USERS', 'Your LINE user id, starts with U (Enter if you do not know it yet)', { onlyIf: 'LINE_CHANNEL_SECRET' }],
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
console.log('\nBot setup. Paste each value and press Enter. Press Enter alone to keep the value in [brackets].\n');

for (const [key, label, opt] of QUESTIONS) {
  if (opt.onlyIf && !env[opt.onlyIf]) continue;
  const current = env[key] || opt.def || '';
  const shown = current ? ` [${opt.secret ? mask(current) : current}]` : '';
  for (;;) {
    const answer = (await ask(`${label}${shown}: `)).trim().replace(/^["']|["']$/g, '');
    const value = answer || current;
    if (opt.required && !value) {
      console.log('  This one is required.');
      continue;
    }
    env[key] = value;
    break;
  }
}
rl.close();

if (!env.TELEGRAM_BOT_TOKEN && !env.LINE_CHANNEL_SECRET) {
  console.log('\nNote: you skipped both Telegram and LINE, so the bot has nowhere to chat yet. Run `npm run setup` again to add one.');
}
const body = Object.entries(env)
  .filter(([, v]) => v !== '')
  .map(([k, v]) => `${k}=${v}`)
  .join('\n');
writeFileSync(FILE, `# Written by npm run setup. Keep this file secret.\n${body}\n`);
console.log(`\nSaved to ${FILE}. Now start the bot with:  npm start\n`);
