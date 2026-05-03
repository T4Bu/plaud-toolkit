import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export async function transcriptCommand(args: string[]): Promise<void> {
  const jsonFlag = args.includes('--json');
  const id = args.find(a => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: plaud transcript <recording-id> [--json]');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const creds = config.getCredentials();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds?.region ?? 'eu');

  const segments = await client.getTranscript(id);

  if (segments.length === 0) {
    console.log('No transcript available for this recording.');
    return;
  }

  if (jsonFlag) {
    console.log(JSON.stringify(segments, null, 2));
    return;
  }

  for (const seg of segments) {
    console.log(`[${formatTimestamp(seg.start_time)}] ${seg.speaker}: ${seg.content}`);
  }
}
