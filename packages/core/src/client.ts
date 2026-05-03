import * as fs from 'fs/promises';
import * as zlib from 'zlib';
import { PlaudAuth } from './auth.js';
import { resolveBaseUrl } from './types.js';
import type {
  PlaudRecording,
  PlaudRecordingContentItem,
  PlaudRecordingDetail,
  PlaudUserInfo,
  RecordingSearchFilters,
  TranscriptSegment,
} from './types.js';

const REGION_RE = /^(?:https?:\/\/)?api(?:-([a-z0-9]+))?\.plaud\.ai/i;

function parseRegionFromDomain(domain: string): string {
  const m = REGION_RE.exec(domain);
  return m?.[1]?.toLowerCase() ?? 'us';
}

function classifyContentType(rawType: unknown): string | undefined {
  if (typeof rawType !== 'string') return undefined;
  const t = rawType.toLowerCase();
  if (t.includes('summary')) return 'summary';
  if (t.includes('mindmap') || t.includes('mind_map') || t.includes('mind-map')) return 'mindmap';
  if (t.includes('chapter')) return 'chapters';
  if (t.includes('outline')) return 'outline';
  if (t.includes('mark')) return 'marks';
  return undefined;
}

// Pre-download summary blobs are sometimes a JSON object like {"ai_content":"..."}.
// Pull the human-readable string out, or return the raw blob if not that shape.
function extractSummaryText(blob: string): string {
  if (!blob) return blob;
  if (blob.trim()[0] !== '{') return blob;
  try {
    const parsed = JSON.parse(blob);
    if (typeof parsed?.ai_content === 'string') return parsed.ai_content;
    if (typeof parsed?.content === 'string') return parsed.content;
    if (typeof parsed?.summary === 'string') return parsed.summary;
  } catch { /* fall through */ }
  return blob;
}

export class PlaudClient {
  private auth: PlaudAuth;
  private region: string;

  constructor(auth: PlaudAuth, region: string = 'us') {
    this.auth = auth;
    this.region = region;
  }

  private get baseUrl(): string {
    return resolveBaseUrl(this.region);
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    // Handle region mismatch
    if (data?.status === -302 && data?.data?.domains?.api) {
      const newRegion = parseRegionFromDomain(data.data.domains.api);
      if (newRegion === this.region) {
        throw new Error(`Plaud region redirect loop for '${newRegion}'`);
      }
      this.region = newRegion;
      return this.request(path, options);
    }

    return data;
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web');
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? [];
    return list.filter(r => !r.is_trash);
  }

  // Returns recording metadata + AI artifacts from `pre_download_content_list`
  // (summary, marks, outline, mind-map). Does NOT contain the verbatim speech
  // transcript — the field `transcript` is always '' for shape compatibility.
  // Use getTranscript() for the actual spoken content.
  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;

    const preDownload: any[] = raw.pre_download_content_list ?? [];
    const content_items: PlaudRecordingContentItem[] = preDownload.map(item => {
      const rawType =
        item.type ?? item.data_type ?? item.content_type ?? item.name ?? undefined;
      return {
        type: classifyContentType(rawType),
        raw_type: typeof rawType === 'string' ? rawType : undefined,
        content: item.data_content ?? '',
        ...item,
      };
    });

    const summaryItem = content_items.find(i => i.type === 'summary' && i.content);
    const summary = summaryItem
      ? extractSummaryText(summaryItem.content)
      : (typeof raw.summary === 'string' ? raw.summary : undefined);

    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript: '',
      summary,
      content_items,
      raw,
    } as PlaudRecordingDetail;
  }

  // Fetches the verbatim speech transcript. Looks up the transaction item in
  // `content_list[]` (a 15-min S3-presigned URL holding gzipped JSON of
  // speaker-labeled segments) and returns the parsed segment array.
  async getTranscript(id: string): Promise<TranscriptSegment[]> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;
    const list: any[] = raw.content_list ?? [];
    const tx = list.find(it => it?.data_type === 'transaction');
    if (!tx?.data_link) return [];

    const res = await fetch(tx.data_link);
    if (!res.ok) throw new Error(`Transcript fetch failed: ${res.status} ${res.statusText}`);
    // Some fetch implementations (undici) transparently decompress responses
    // whose Content-Encoding is gzip; others return the raw gzip bytes. Detect
    // the gzip magic number and decompress manually only when needed.
    const buf = Buffer.from(await res.arrayBuffer());
    const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const text = isGzip ? zlib.gunzipSync(buf).toString('utf-8') : buf.toString('utf-8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed as TranscriptSegment[] : [];
  }

  async getRecordingsBatch(
    ids: string[],
    concurrency: number = 3,
  ): Promise<PlaudRecordingDetail[]> {
    const results: PlaudRecordingDetail[] = [];
    for (let i = 0; i < ids.length; i += concurrency) {
      const slice = ids.slice(i, i + concurrency);
      const settled = await Promise.all(slice.map(id => this.getRecording(id)));
      results.push(...settled);
    }
    return results;
  }

  async getTranscriptsBatch(
    ids: string[],
    concurrency: number = 3,
  ): Promise<{ id: string; segments: TranscriptSegment[] }[]> {
    const results: { id: string; segments: TranscriptSegment[] }[] = [];
    for (let i = 0; i < ids.length; i += concurrency) {
      const slice = ids.slice(i, i + concurrency);
      const settled = await Promise.all(
        slice.map(async id => ({ id, segments: await this.getTranscript(id) })),
      );
      results.push(...settled);
    }
    return results;
  }

  async searchRecordings(filters: RecordingSearchFilters): Promise<PlaudRecording[]> {
    const all = await this.listRecordings();
    const fromMs = filters.date_from ? Date.parse(filters.date_from) : -Infinity;
    const toMs = filters.date_to ? Date.parse(filters.date_to) : Infinity;
    const titleNeedle = filters.title_contains?.toLowerCase();
    const kwNeedle = filters.keyword?.toLowerCase();
    return all.filter(r => {
      if (r.start_time < fromMs || r.start_time > toMs) return false;
      if (titleNeedle && !(r.filename ?? '').toLowerCase().includes(titleNeedle)) return false;
      if (kwNeedle && !(r.keywords ?? []).some(k => k.toLowerCase().includes(kwNeedle))) return false;
      if (filters.has_transcript === true && !r.is_trans) return false;
      if (filters.has_transcript === false && r.is_trans) return false;
      if (filters.has_summary === true && !r.is_summary) return false;
      if (filters.has_summary === false && r.is_summary) return false;
      const durMin = (r.duration ?? 0) / 60000;
      if (filters.min_duration_minutes != null && durMin < filters.min_duration_minutes) return false;
      if (filters.max_duration_minutes != null && durMin > filters.max_duration_minutes) return false;
      return true;
    });
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/user/me');
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? 'unknown',
    };
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async downloadAudioToFile(id: string, outPath: string): Promise<void> {
    const buf = await this.downloadAudio(id);
    await fs.writeFile(outPath, Buffer.from(buf));
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch {
      return null;
    }
  }
}
