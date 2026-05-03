import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudClient } from '../src/client.js';
import { PlaudAuth } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PlaudClient', () => {
  let tmpDir: string;
  let client: PlaudClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-client-'));
    const config = new PlaudConfig(tmpDir);
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    config.saveCredentials({ email: 't@t.com', password: 'p', region: 'eu' });
    config.saveToken({
      accessToken: token,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });
    const auth = new PlaudAuth(config);
    client = new PlaudClient(auth, 'eu');
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists recordings', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_file_list: [
          { id: 'rec1', filename: 'Test', is_trash: false },
          { id: 'rec2', filename: 'Trash', is_trash: true },
        ],
      }),
    });

    const recs = await client.listRecordings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('rec1');
  });

  it('getRecording returns metadata only (no transcript fabricated from AI blobs)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data: {
          file_id: 'rec1',
          file_name: 'Meeting',
          pre_download_content_list: [
            { data_content: '[{"mark_type":1,"mark_content":"some AI-generated mark"}]' },
            { data_content: '{"ai_content":"AI summary here"}' },
          ],
        },
      }),
    });

    const detail = await client.getRecording('rec1');
    expect(detail.filename).toBe('Meeting');
    expect(detail.transcript).toBe('');
  });

  it('getTranscript fetches the transaction content_list item, gunzips, and returns segments', async () => {
    const segments = [
      { start_time: 8520, end_time: 23040, content: 'Hello world.', speaker: 'Speaker 1', original_speaker: 'Speaker 1' },
      { start_time: 39600, end_time: 70180, content: 'Second segment.', speaker: 'Speaker 2', original_speaker: 'Speaker 2' },
    ];
    const signedUrl = 'https://s3.example.com/trans_result.json.gz?X-Amz-Signature=fake';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data: {
          file_id: 'rec1',
          content_list: [
            { data_type: 'outline', data_link: 'https://s3.example.com/outline' },
            { data_type: 'transaction', data_link: signedUrl },
            { data_type: 'mark_memo', data_link: 'https://s3.example.com/marks' },
          ],
        },
      }),
    });

    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(segments), 'utf-8'));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    });

    const out = await client.getTranscript('rec1');
    expect(out).toEqual(segments);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(signedUrl);
  });

  it('getTranscript returns empty array when no transaction content is available', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data: { file_id: 'rec1', content_list: [{ data_type: 'outline', data_link: 'x' }] },
      }),
    });

    const out = await client.getTranscript('rec1');
    expect(out).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('gets user info', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_user: { id: 'u1', nickname: 'Sergi', email: 'test@plaud.ai', country: 'ES', membership_type: 'starter' },
      }),
    });

    const user = await client.getUserInfo();
    expect(user.nickname).toBe('Sergi');
  });

  it('handles region mismatch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: -302,
        data: { domains: { api: 'api-euc1.plaud.ai' } },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_file_list: [{ id: 'rec1', filename: 'Test', is_trash: false }],
      }),
    });

    const recs = await client.listRecordings();
    expect(recs).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('routes to apne1 on -302 redirect and retries against the Tokyo host', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: -302,
        data: { domains: { api: 'https://api-apne1.plaud.ai' } },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_file_list: [{ id: 'rec1', filename: 'Test', is_trash: false }],
      }),
    });

    await client.listRecordings();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstUrl = mockFetch.mock.calls[0][0] as string;
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(firstUrl).toContain('api-euc1.plaud.ai');
    expect(secondUrl).toContain('api-apne1.plaud.ai');
  });

  it('throws on redirect loop to the same region', async () => {
    const loopConfig = new PlaudConfig(tmpDir);
    const loopAuth = new PlaudAuth(loopConfig);
    const loopClient = new PlaudClient(loopAuth, 'apne1');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: -302,
        data: { domains: { api: 'https://api-apne1.plaud.ai' } },
      }),
    });

    await expect(loopClient.listRecordings()).rejects.toThrow(/redirect loop/);
  });
});
