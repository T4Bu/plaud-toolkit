import * as readline from 'readline';
import { PlaudConfig, PlaudAuth, PlaudClient, decodePlaudJwt, normalizeRegion, BASE_URLS } from '@plaud/core';

interface ParsedToken {
  accessToken: string;
  tokenType: string;
  iat: number;
  exp: number;
  region: string;
}

function parseTokenstr(raw: string): ParsedToken {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) throw new Error('Empty input.');

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts[0].toLowerCase() !== 'bearer') {
    throw new Error("Expected 'Bearer <jwt>' format. Copy the full value of localStorage.tokenstr, including the 'Bearer ' prefix.");
  }

  const tokenType = parts[0];
  const jwt = parts.slice(1).join('');
  if (jwt.split('.').length !== 3) {
    throw new Error('Not a valid JWT (expected 3 dot-separated segments).');
  }

  let claims;
  try {
    claims = decodePlaudJwt(jwt);
  } catch {
    throw new Error('Malformed JWT payload — could not base64-decode or parse claims.');
  }

  if (!claims.iat || !claims.exp) {
    throw new Error("JWT missing 'iat' or 'exp' claims.");
  }
  if (claims.exp * 1000 <= Date.now()) {
    throw new Error('Token is already expired. Refresh web.plaud.ai and copy a new tokenstr.');
  }

  // JWT region may be AWS-style (`aws:ap-northeast-1`); normalize to short code
  // when possible. Unknown regions fall back to 'us' — the server's -302
  // redirect will route us to the correct host on the first call.
  const normalized = claims.region ? normalizeRegion(claims.region) : 'us';
  const region = BASE_URLS[normalized] ? normalized : 'us';

  return {
    accessToken: jwt,
    tokenType,
    iat: claims.iat,
    exp: claims.exp,
    region,
  };
}

export async function ssoLoginCommand(_args: string[]): Promise<void> {
  console.log(`To get your SSO token:
  1. Open https://web.plaud.ai and sign in with Google or Apple.
  2. Open the browser DevTools Console (Cmd+Option+J / F12).
  3. Run: localStorage.pld_tokenstr
     (older builds used localStorage.tokenstr — try that if pld_tokenstr is undefined)
  4. Copy the output (the whole string starting with "Bearer ").
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  try {
    const raw = await ask('Paste tokenstr: ');
    const parsed = parseTokenstr(raw);

    const config = new PlaudConfig();
    config.save({
      credentials: { region: parsed.region, authMode: 'sso' },
      token: {
        accessToken: parsed.accessToken,
        tokenType: parsed.tokenType,
        issuedAt: parsed.iat * 1000,
        expiresAt: parsed.exp * 1000,
      },
    });

    const auth = new PlaudAuth(config);
    const client = new PlaudClient(auth, parsed.region);
    const user = await client.getUserInfo();

    const expiresOn = new Date(parsed.exp * 1000).toISOString().slice(0, 10);
    const daysLeft = Math.ceil((parsed.exp * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
    console.log(`Logged in as ${user.email || user.nickname} (region: ${parsed.region}, expires ${expiresOn}, ~${daysLeft} days left).`);
    console.log(`The CLI will prompt you to re-run 'plaud login-sso' within 30 days of expiry.`);
  } finally {
    rl.close();
  }
}
