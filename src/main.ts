import { createServer, type IncomingMessage } from 'node:http';
import { Agent, anthropicCreate } from './agent';
import { Channels } from './channel';
import { config } from './config';
import { Line, verifyLineSignature } from './line';
import { Scheduler } from './scheduler';
import { Store } from './store';
import { Telegram } from './telegram';

const store = new Store(config.dataDir);
const agent = new Agent(config, store, anthropicCreate());
const channels = new Channels();

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn('ANTHROPIC_API_KEY is not set; Claude calls will fail unless an `ant auth login` profile exists.');
}

const telegram = config.telegram.token ? new Telegram(config.telegram, agent) : null;
const line = config.line.channelSecret && config.line.accessToken ? new Line(config.line, agent) : null;
if (telegram) channels.add(telegram);
if (line) channels.add(line);
if (!telegram && !line) console.warn('Neither Telegram nor LINE is configured. See README.md.');

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method === 'POST' && path === '/telegram' && telegram && config.telegram.mode === 'webhook') {
      if (!telegram.verifyWebhook(req.headers['x-telegram-bot-api-secret-token'] as string | undefined)) {
        res.writeHead(401).end();
        return;
      }
      const update = JSON.parse(await readBody(req));
      res.writeHead(200).end(); // answer now; the agent may take a while
      void telegram.handleUpdate(update);
      return;
    }
    if (req.method === 'POST' && path === '/line' && line) {
      const raw = await readBody(req);
      if (!verifyLineSignature(config.line.channelSecret, raw, req.headers['x-line-signature'] as string | undefined)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end();
      void line.handleWebhook(JSON.parse(raw));
      return;
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error('HTTP handler error:', e);
    if (!res.headersSent) res.writeHead(400).end();
  }
});

server.listen(config.port, () => {
  console.log(`${config.botName} listening on :${config.port} (model ${config.model}, effort ${config.effort})`);
  if (line) console.log(`LINE webhook path: POST /line`);
});

if (telegram) {
  if (config.telegram.mode === 'polling') void telegram.poll();
  else if (process.env.TELEGRAM_WEBHOOK_URL) void telegram.setWebhook(process.env.TELEGRAM_WEBHOOK_URL).catch((e) => console.error(e));
}

const scheduler = new Scheduler(config, store, channels);
scheduler.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    telegram?.stop();
    scheduler.stop();
    server.close();
    process.exit(0);
  });
}
