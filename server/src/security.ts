/** Who may call the API from a web page. The phone app and tools like curl send no Origin header at all. */

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^\[::1\]$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/, // Tailscale (CGNAT range)
  /\.ts\.net$/i,
];

/** Comma-separated extra origins from env CORS_ORIGINS, e.g. "https://my.example.com". */
export function extraOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function corsOriginAllowed(origin: string | undefined, extra: string[] = extraOrigins()): boolean {
  if (!origin) return true;
  if (extra.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return PRIVATE_HOST.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** "…a1b2" instead of the whole key. */
export function maskKey(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}
