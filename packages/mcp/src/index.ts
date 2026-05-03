#!/usr/bin/env npx tsx
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  PlaudConfig,
  PlaudAuth,
  PlaudClient,
  type PlaudRecording,
} from '@plaud/core';

function compact(r: PlaudRecording) {
  return {
    id: r.id,
    title: r.filename,
    date: new Date(r.start_time).toISOString().slice(0, 16),
    duration_minutes: Math.round((r.duration ?? 0) / 60000),
    has_transcript: r.is_trans,
    has_summary: r.is_summary,
    keywords: r.keywords,
  };
}

function toText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

async function main() {
  const config = new PlaudConfig();
  const creds = config.getCredentials();

  if (!creds) {
    console.error('No Plaud credentials found. Run `plaud login` (email+password) or `plaud login-sso` (Google/Apple SSO) first.');
    process.exit(1);
  }

  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds.region);

  const server = new McpServer({ name: 'plaud-mcp', version: '0.2.0' });

  const recordingIdSchema = { recording_id: z.string().describe('The recording ID') };

  server.tool(
    'plaud_list_recordings',
    'List Plaud recordings (newest first, paginated). Returns compact metadata only — id, title, date, duration, transcript/summary flags, keywords. For filtered results use plaud_search; for full-text content search use plaud_search_transcripts.',
    {
      limit: z.number().int().min(1).max(500).optional().describe('Max recordings to return. Default 50, max 500.'),
      offset: z.number().int().min(0).optional().describe('How many recordings to skip from the newest. Default 0.'),
    },
    async (params) => {
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const recs = await client.listRecordings();
      recs.sort((a, b) => b.start_time - a.start_time);
      const slice = recs.slice(offset, offset + limit);
      return toText({
        total: recs.length,
        offset,
        returned: slice.length,
        recordings: slice.map(compact),
      });
    },
  );

  server.tool(
    'plaud_search',
    'Search recordings by metadata: date range, title substring, keyword, duration, transcript/summary flags. Fast — uses the list endpoint only. Returns compact metadata. Use this BEFORE plaud_search_transcripts to narrow the candidate set.',
    {
      date_from: z.string().optional().describe('ISO date or datetime, e.g. "2025-01-01" or "2025-01-01T00:00:00Z". Inclusive lower bound on recording start time.'),
      date_to: z.string().optional().describe('ISO date or datetime. Inclusive upper bound on recording start time.'),
      title_contains: z.string().optional().describe('Case-insensitive substring matched against the recording title.'),
      keyword: z.string().optional().describe('Case-insensitive match against the keywords array.'),
      has_transcript: z.boolean().optional(),
      has_summary: z.boolean().optional(),
      min_duration_minutes: z.number().optional(),
      max_duration_minutes: z.number().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const recs = await client.searchRecordings(params);
      recs.sort((a, b) => b.start_time - a.start_time);
      const slice = recs.slice(offset, offset + limit);
      return toText({
        matched: recs.length,
        offset,
        returned: slice.length,
        recordings: slice.map(compact),
      });
    },
  );

  server.tool(
    'plaud_search_transcripts',
    'Full-text search across the verbatim speech transcripts of recordings. SLOW — fetches each candidate (one detail call + one S3 fetch per recording). Always pre-filter with date_from/date_to or title_contains to keep the candidate set small. Returns matching segments with speaker, timestamp, and surrounding context.',
    {
      query: z.string().min(1).describe('Case-insensitive substring to find in transcript text.'),
      date_from: z.string().optional().describe('ISO date pre-filter on recording start time.'),
      date_to: z.string().optional().describe('ISO date pre-filter on recording start time.'),
      title_contains: z.string().optional(),
      keyword: z.string().optional(),
      max_recordings_to_scan: z.number().int().min(1).max(50).optional()
        .describe('Hard cap on how many recordings to fetch. Default 20, max 50. Most recent matching candidates are scanned first.'),
      max_hits_per_recording: z.number().int().min(1).max(20).optional()
        .describe('Cap segments returned per recording. Default 3.'),
    },
    async (params) => {
      const cap = params.max_recordings_to_scan ?? 20;
      const perRec = params.max_hits_per_recording ?? 3;
      const candidates = await client.searchRecordings({
        date_from: params.date_from,
        date_to: params.date_to,
        title_contains: params.title_contains,
        keyword: params.keyword,
        has_transcript: true,
      });
      candidates.sort((a, b) => b.start_time - a.start_time);
      const scanList = candidates.slice(0, cap);

      const transcripts = await client.getTranscriptsBatch(scanList.map(c => c.id));
      const byId = new Map(scanList.map(c => [c.id, c]));
      const needle = params.query.toLowerCase();

      const results = transcripts.flatMap(({ id, segments }) => {
        const rec = byId.get(id);
        if (!rec) return [];
        const matches: any[] = [];
        for (const seg of segments) {
          if ((seg.content ?? '').toLowerCase().includes(needle)) {
            matches.push({
              timestamp: formatTimestamp(seg.start_time),
              start_time_ms: seg.start_time,
              speaker: seg.speaker,
              text: seg.content,
            });
            if (matches.length >= perRec) break;
          }
        }
        if (matches.length === 0) return [];
        return [{
          id: rec.id,
          title: rec.filename,
          date: new Date(rec.start_time).toISOString().slice(0, 16),
          match_count: matches.length,
          matches,
        }];
      });

      return toText({
        query: params.query,
        candidates_matched_filter: candidates.length,
        candidates_scanned: scanList.length,
        truncated: candidates.length > scanList.length,
        recordings_with_hits: results.length,
        results,
      });
    },
  );

  server.tool(
    'plaud_get_transcript',
    'Get the verbatim speech transcript of a recording as speaker-labeled segments with millisecond timestamps. The transcript lives at content_list[].data_type === "transaction" — fetched on demand via a 15-minute S3 presigned URL.',
    {
      recording_id: z.string().describe('The recording ID'),
      format: z.enum(['segments', 'flat_text']).optional().describe('"segments" (default) returns the structured array; "flat_text" returns one timestamped line per segment.'),
    },
    async (params) => {
      const segments = await client.getTranscript(params.recording_id);
      if (params.format === 'flat_text') {
        const lines = segments.map(s => `[${formatTimestamp(s.start_time)}] ${s.speaker}: ${s.content}`);
        return toText({
          id: params.recording_id,
          segment_count: segments.length,
          text: lines.join('\n'),
        });
      }
      return toText({
        id: params.recording_id,
        segment_count: segments.length,
        segments,
      });
    },
  );

  server.tool(
    'plaud_get_summary',
    'Get the AI-generated summary of a recording (if Plaud generated one). Pulled from the pre-download content list, not the speech transcript.',
    recordingIdSchema,
    async (params) => {
      const detail = await client.getRecording(params.recording_id);
      return toText({
        id: detail.id,
        title: detail.filename,
        summary: detail.summary ?? null,
        has_summary: !!detail.summary,
      });
    },
  );

  server.tool(
    'plaud_get_recording_detail',
    'Get metadata for a recording: title, duration, timestamps, AI summary, plus any other AI artifacts in `content_items` (marks, outline, mind-map). Does NOT contain the verbatim transcript — use plaud_get_transcript for spoken content.',
    recordingIdSchema,
    async (params) => {
      const detail = await client.getRecording(params.recording_id);
      const { raw, transcript: _drop, ...clean } = detail;
      return toText(clean);
    },
  );

  server.tool(
    'plaud_get_recording_raw',
    'Return the FULL unfiltered API response for a recording. Use this to discover undocumented fields (chapters, speakers, action items, etc.) before they have dedicated tools. Output may be large.',
    recordingIdSchema,
    async (params) => {
      const detail = await client.getRecording(params.recording_id);
      return toText(detail.raw ?? {});
    },
  );

  server.tool(
    'plaud_get_recordings_batch',
    'Fetch transcripts and/or summaries for multiple recordings in one call. Each ID costs one (summary) or two (transcript) API round-trips — use sparingly. Cap is 20 IDs per call.',
    {
      recording_ids: z.array(z.string()).min(1).max(20),
      include_transcripts: z.boolean().optional().describe('Default true. Each transcript = 1 detail call + 1 S3 fetch.'),
      include_summaries: z.boolean().optional().describe('Default true.'),
    },
    async (params) => {
      const includeTr = params.include_transcripts ?? true;
      const includeSum = params.include_summaries ?? true;

      const detailsP = includeSum
        ? client.getRecordingsBatch(params.recording_ids)
        : Promise.resolve(null);
      const transcriptsP = includeTr
        ? client.getTranscriptsBatch(params.recording_ids)
        : Promise.resolve(null);
      const [details, transcripts] = await Promise.all([detailsP, transcriptsP]);

      const txById = new Map(transcripts?.map(t => [t.id, t.segments]) ?? []);
      const detById = new Map(details?.map(d => [d.id, d]) ?? []);

      const result = params.recording_ids.map(id => {
        const d = detById.get(id);
        const segs = txById.get(id);
        return {
          id,
          title: d?.filename ?? null,
          date: d ? new Date(d.start_time).toISOString().slice(0, 16) : null,
          ...(includeTr ? { transcript_segment_count: segs?.length ?? 0, transcript_segments: segs ?? [] } : {}),
          ...(includeSum ? { summary: d?.summary ?? null } : {}),
        };
      });
      return toText(result);
    },
  );

  server.tool(
    'plaud_download_recording',
    'Download the MP3 of a recording to a local path.',
    {
      recording_id: z.string(),
      output_path: z.string().describe('Absolute path where the MP3 file should be saved.'),
    },
    async (params) => {
      await client.downloadAudioToFile(params.recording_id, params.output_path);
      return toText({ ok: true, path: params.output_path });
    },
  );

  server.tool(
    'plaud_user_info',
    'Get current Plaud user information (id, nickname, email, country, membership tier).',
    async () => {
      const user = await client.getUserInfo();
      return toText(user);
    },
  );

  server.tool(
    'plaud_get_mp3_url',
    'Get a temporary download URL for the MP3 of a recording. The URL is short-lived.',
    recordingIdSchema,
    async (params) => {
      const url = await client.getMp3Url(params.recording_id);
      return toText({
        url: url || null,
        message: url ? 'Temporary URL valid for a short time.' : 'No MP3 available.',
      });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
