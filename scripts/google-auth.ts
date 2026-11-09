// One-time Google sign-in: `npm run google-auth`.
// Needs credentials.json (an OAuth "Desktop app" client from Google Cloud) in the data folder.
// Works on a laptop or headless on a NAS: open the printed link anywhere, approve, and either
// the redirect reaches this script directly, or you paste the address from the browser here.
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { GOOGLE_SCOPES, credentialsPath, readClient, tokenPath } from '../src/google';

const dataDir = process.env.BOT_DATA_DIR ?? './data';
const PORT = Number(process.env.GOOGLE_AUTH_PORT ?? 53682);
const redirectUri = `http://127.0.0.1:${PORT}`;

mkdirSync(dataDir, { recursive: true });
const credsFile = credentialsPath(dataDir);
if (!existsSync(credsFile) && existsSync('credentials.json')) copyFileSync('credentials.json', credsFile);
if (!existsSync(credsFile)) {
  console.error(`\nI need ${credsFile}.\nDownload your OAuth client (Desktop app) from Google Cloud > APIs & Services > Credentials,\nrename it to credentials.json and put it in ${dataDir}/ (see SETUP-GUIDE.md, "Connect Google").\n`);
  process.exit(1);
}
const client = readClient(credsFile);

const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('hex');
const authUrl = `${client.auth_uri}?${new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: GOOGLE_SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
})}`;

async function finish(code: string) {
  const res = await fetch(client.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string; error?: string };
  if (!json.access_token || !json.refresh_token) {
    console.error(`\nGoogle did not return a token: ${json.error_description ?? json.error ?? res.status}. Run npm run google-auth again.`);
    process.exit(1);
  }
  writeFileSync(
    tokenPath(dataDir),
    JSON.stringify({ access_token: json.access_token, refresh_token: json.refresh_token, expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000, scope: json.scope }, null, 1),
  );
  console.log(`\n✅ Google connected. Saved ${tokenPath(dataDir)}. Restart the bot to use Calendar, Gmail, Tasks and Drive.\n`);
  process.exit(0);
}

/** Accepts either the full redirected address or just the code. */
function codeFrom(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.searchParams.get('state') && u.searchParams.get('state') !== state) {
      console.error('That link is from a different sign-in attempt. Use the link printed above.');
      return null;
    }
    return u.searchParams.get('code');
  } catch {
    return s;
  }
}

const server = createServer((req, res) => {
  const code = codeFrom(`${redirectUri}${req.url ?? ''}`);
  if (!code) {
    res.writeHead(400).end('No code in this request.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>✅ Signed in. You can close this tab and go back to the terminal.</h2>');
  void finish(code);
});
server.on('error', () => console.log('(Could not listen for the redirect; paste the address instead.)'));
server.listen(PORT, '127.0.0.1');

console.log('\n1. Open this link in a browser and sign in with the Google account you added as a test user:\n');
console.log(authUrl);
console.log(
  '\n2. Google may warn "Google hasn\'t verified this app": click Advanced, then Go to ... (unsafe). It is your own app.' +
    '\n3. Allow access. If the browser then shows "This site can\'t be reached" (normal when the bot runs on another machine),' +
    '\n   copy the whole address from the address bar and paste it here, then press Enter.\n',
);
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const code = codeFrom(line);
  if (code) void finish(code);
});
