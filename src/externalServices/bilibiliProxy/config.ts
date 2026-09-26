function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

export const BILIBILI_PROXY_CONFIG = {
  port: envInt('BILIBILI_PROXY_PORT', 3892),
  bindAddress: envString('BILIBILI_PROXY_BIND_ADDRESS', '127.0.0.1'),
} as const;
