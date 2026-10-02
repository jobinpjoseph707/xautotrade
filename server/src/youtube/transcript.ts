/**
 * Transcript fetching. Uses caption text only (never video/audio scraping).
 * The fetcher is injectable so tests and offline use never hit the network.
 */

export type TranscriptFetcher = (videoUrlOrId: string) => Promise<string>;

export function parseVideoId(input: string): string {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      if (/^[\w-]{11}$/.test(id)) return id;
    }
    if (u.hostname.endsWith('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* fall through */
  }
  throw new Error(`Not a recognisable YouTube URL or video id: ${input}`);
}

/**
 * Default fetcher: the `youtube-transcript` package (install with `npm install`).
 * Loaded lazily so the rest of the pipeline works without it.
 */
export const defaultFetcher: TranscriptFetcher = async (videoUrlOrId) => {
  const id = parseVideoId(videoUrlOrId);
  const moduleName = 'youtube-transcript';
  let mod: { YoutubeTranscript: { fetchTranscript(id: string): Promise<{ text: string }[]> } };
  try {
    mod = (await import(moduleName)) as typeof mod;
  } catch {
    throw new Error("The 'youtube-transcript' package is not installed. Run `npm install` in server/.");
  }
  const parts = await mod.YoutubeTranscript.fetchTranscript(id);
  return parts.map((p) => p.text).join(' ');
};

export async function fetchTranscript(url: string, fetcher: TranscriptFetcher = defaultFetcher): Promise<string> {
  const text = (await fetcher(url)).replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Transcript is empty (captions may be disabled for this video).');
  return text;
}
