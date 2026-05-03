export type PlaudAuthMode = 'password' | 'sso';

export interface PlaudCredentials {
  region: string;
  email?: string;
  password?: string;
  authMode?: PlaudAuthMode; // absent = 'password' (back-compat)
}

export interface PlaudTokenData {
  accessToken: string;
  tokenType: string;
  issuedAt: number;   // epoch ms
  expiresAt: number;  // epoch ms (decoded from JWT)
}

export interface PlaudConfig {
  credentials?: PlaudCredentials;
  token?: PlaudTokenData;
}

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
  euc1: 'https://api-euc1.plaud.ai',
  apne1: 'https://api-apne1.plaud.ai',
};

// Plaud JWTs carry a `region` claim in AWS format (e.g. `aws:ap-northeast-1`),
// while API hostnames use short codes (`apne1`). Normalize known values; pass
// anything else through untouched so callers can still try it via resolveBaseUrl.
const JWT_REGION_ALIASES: Record<string, string> = {
  'aws:us-east-1': 'us',
  'aws:eu-central-1': 'euc1',
  'aws:ap-northeast-1': 'apne1',
};

export function normalizeRegion(raw: string): string {
  return JWT_REGION_ALIASES[raw] ?? raw;
}

export function resolveBaseUrl(region: string): string {
  return BASE_URLS[region] ?? `https://api-${region}.plaud.ai`;
}

export interface PlaudRecording {
  id: string;
  filename: string;
  fullname: string;
  filesize: number;
  duration: number;
  start_time: number;
  end_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  keywords: string[];
  serial_number: string;
}

// Items found in the detail endpoint's `pre_download_content_list` — these are
// AI-generated artifacts (summary, marks, outline, mind-map). NOT the speech
// transcript; for that, use PlaudClient.getTranscript() which fetches the
// gzipped JSON from `content_list[].data_type === 'transaction'`.
export interface PlaudRecordingContentItem {
  type?: 'summary' | 'marks' | 'mindmap' | 'chapters' | 'outline' | string;
  raw_type?: string;
  content: string;
  [key: string]: any;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  // Always '' from getRecording — kept for shape compatibility. Use getTranscript() for speech.
  transcript: string;
  summary?: string;
  content_items: PlaudRecordingContentItem[];
  raw: any;
}

export interface TranscriptSegment {
  start_time: number;   // ms from start
  end_time: number;     // ms from start
  content: string;
  speaker: string;
  original_speaker?: string;
}

export interface RecordingSearchFilters {
  date_from?: string;
  date_to?: string;
  title_contains?: string;
  keyword?: string;
  has_transcript?: boolean;
  has_summary?: boolean;
  min_duration_minutes?: number;
  max_duration_minutes?: number;
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  country: string;
  membership_type: string;
}
