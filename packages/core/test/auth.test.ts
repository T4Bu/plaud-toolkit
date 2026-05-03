import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudAuth, decodePlaudJwt } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function makeJwt(claims: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PlaudAuth', () => {
  let tmpDir: string;
  let config: PlaudConfig;
  let auth: PlaudAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-auth-'));
    config = new PlaudConfig(tmpDir);
    config.saveCredentials({ email: 'test@plaud.ai', password: 'pass123', region: 'eu' });
    auth = new PlaudAuth(config);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs in with email+password and stores token', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);

    const stored = config.getToken();
    expect(stored?.accessToken).toBe(fakeToken);
  });

  it('returns cached token when still valid', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: fakeToken,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes token when expired', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 1000;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: pastExp, iat: pastExp - 86400 })).toString('base64url');
    const expiredToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: expiredToken,
      tokenType: 'Bearer',
      issuedAt: (pastExp - 86400) * 1000,
      expiresAt: pastExp * 1000,
    });

    const newExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const newPayload = Buffer.from(JSON.stringify({ sub: 'abc', exp: newExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const newToken = `eyJhbGciOiJIUzI1NiJ9.${newPayload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: newToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(newToken);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws when no credentials stored', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-empty-'));
    const emptyConfig = new PlaudConfig(emptyDir);
    const emptyAuth = new PlaudAuth(emptyConfig);

    await expect(emptyAuth.getToken()).rejects.toThrow('No credentials');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('throws on wrong credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -2, msg: 'wrong account or password', access_token: '' }),
    });

    await expect(auth.getToken()).rejects.toThrow('wrong account or password');
  });
});

describe('PlaudAuth SSO mode', () => {
  let tmpDir: string;
  let config: PlaudConfig;
  let auth: PlaudAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-sso-'));
    config = new PlaudConfig(tmpDir);
    config.saveCredentials({ region: 'apne1', authMode: 'sso' });
    auth = new PlaudAuth(config);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns cached SSO token without calling fetch', async () => {
    const now = Math.floor(Date.now() / 1000);
    const futureExp = now + 300 * 86400;
    const token = makeJwt({ sub: 'abc', iat: now, exp: futureExp, region: 'apne1' });
    config.saveToken({
      accessToken: token,
      tokenType: 'Bearer',
      issuedAt: now * 1000,
      expiresAt: futureExp * 1000,
    });

    const result = await auth.getToken();
    expect(result).toBe(token);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws with login-sso hint when SSO token is within 30 days of expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    const nearExp = now + 10 * 86400;
    const token = makeJwt({ sub: 'abc', iat: now - 86400, exp: nearExp, region: 'apne1' });
    config.saveToken({
      accessToken: token,
      tokenType: 'Bearer',
      issuedAt: (now - 86400) * 1000,
      expiresAt: nearExp * 1000,
    });

    await expect(auth.getToken()).rejects.toThrow(/login-sso/);
  });

  it('throws when no SSO token stored', async () => {
    await expect(auth.getToken()).rejects.toThrow(/login-sso/);
  });

  it('login() refuses to run on an SSO config', async () => {
    await expect(auth.login()).rejects.toThrow(/SSO mode/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('decodePlaudJwt', () => {
  it('extracts iat, exp, and region', () => {
    const jwt = makeJwt({ iat: 100, exp: 200, region: 'apne1' });
    const claims = decodePlaudJwt(jwt);
    expect(claims).toEqual({ iat: 100, exp: 200, region: 'apne1' });
  });

  it('returns undefined region when claim is absent', () => {
    const jwt = makeJwt({ iat: 100, exp: 200 });
    const claims = decodePlaudJwt(jwt);
    expect(claims.region).toBeUndefined();
  });

  it('rejects malformed JWTs', () => {
    expect(() => decodePlaudJwt('not.a.jwt.with.too.many.dots')).toThrow('Invalid JWT');
    expect(() => decodePlaudJwt('only-one-segment')).toThrow('Invalid JWT');
  });
});
