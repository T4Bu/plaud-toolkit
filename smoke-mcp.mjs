// Smoke test: spawn the MCP server with a stub SSO config, send the JSON-RPC
// handshake, and verify tools/list returns all expected tools with valid
// schemas. No real API calls.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-smoke-'));
fs.mkdirSync(path.join(tmpHome, '.plaud'));

// Build a stub JWT with iat/exp/region claims, far-future expiry.
const now = Math.floor(Date.now() / 1000);
const exp = now + 300 * 86400;
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: 'smoke', iat: now, exp, region: 'us' })).toString('base64url');
const fakeJwt = `${header}.${payload}.sig`;

fs.writeFileSync(path.join(tmpHome, '.plaud', 'config.json'), JSON.stringify({
  credentials: { region: 'us', authMode: 'sso' },
  token: { accessToken: fakeJwt, tokenType: 'Bearer', issuedAt: now * 1000, expiresAt: exp * 1000 },
}));

const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
const child = spawn('npx', ['tsx', 'packages/mcp/src/index.ts'], {
  env, stdio: ['pipe', 'pipe', 'pipe'], shell: true,
});

let stdoutBuf = '';
let stderrBuf = '';
const responses = [];
let resolveDone;
const done = new Promise(r => { resolveDone = r; });

child.stdout.on('data', chunk => {
  stdoutBuf += chunk.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (line) {
      try { responses.push(JSON.parse(line)); } catch { /* skip */ }
      if (responses.length >= 2) resolveDone();
    }
  }
});
child.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });
child.on('error', err => { console.error('spawn error:', err); resolveDone(); });

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

// Wait briefly for the server to be ready, then send initialize + tools/list.
await new Promise(r => setTimeout(r, 1500));
send({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'plaud_list_recordings', arguments: { limit: 5 } } });

const done3 = new Promise(r => {
  const i = setInterval(() => {
    if (responses.find(x => x.id === 3)) { clearInterval(i); r(); }
  }, 100);
  setTimeout(() => { clearInterval(i); r(); }, 12000);
});
await done3;

child.kill();
fs.rmSync(tmpHome, { recursive: true, force: true });

const initResp = responses.find(r => r.id === 1);
const listResp = responses.find(r => r.id === 2);

console.log('--- stderr ---');
console.log(stderrBuf || '(empty)');
console.log('--- initialize response ---');
console.log(initResp ? JSON.stringify(initResp.result, null, 2) : 'MISSING');
console.log('--- tools/list ---');
if (!listResp) {
  console.log('MISSING');
  process.exit(1);
}
const tools = listResp.result?.tools ?? [];
console.log(`Got ${tools.length} tools:`);
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties ?? {}).join(', ');
  console.log(`  - ${t.name} :: { ${props} }`);
}

const expected = [
  'plaud_list_recordings', 'plaud_search', 'plaud_search_transcripts',
  'plaud_get_transcript', 'plaud_get_summary', 'plaud_get_recording_detail',
  'plaud_get_recording_raw', 'plaud_get_recordings_batch',
  'plaud_download_recording', 'plaud_user_info', 'plaud_get_mp3_url',
];
const have = new Set(tools.map(t => t.name));
const missing = expected.filter(n => !have.has(n));
if (missing.length) {
  console.error('MISSING TOOLS:', missing);
  process.exit(1);
}
console.log(`\nOK — all ${expected.length} expected tools present.`);

console.log('\n--- tools/call plaud_list_recordings response ---');
const callResp = responses.find(r => r.id === 3);
if (!callResp) {
  console.log('MISSING (timeout)');
} else if (callResp.error) {
  console.log('Got JSON-RPC error (expected, fake token):');
  console.log(JSON.stringify(callResp.error, null, 2));
} else {
  const text = callResp.result?.content?.[0]?.text ?? '';
  const isErr = callResp.result?.isError;
  console.log(`isError: ${isErr}`);
  console.log(`text (first 400 chars): ${text.slice(0, 400)}`);
}
