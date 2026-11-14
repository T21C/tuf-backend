export const MOD_PLATFORMS = ['windows', 'macos', 'linux'] as const;
export type ModPlatform = typeof MOD_PLATFORMS[number];
export type PlatformDownloadUrls = Partial<Record<ModPlatform, string>>;

export function parseModPlatform(raw: unknown): ModPlatform | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const aliases: Record<string, ModPlatform> = {
    windows: 'windows', win: 'windows', win32: 'windows',
    macos: 'macos', mac: 'macos', osx: 'macos', darwin: 'macos',
    linux: 'linux',
  };
  return aliases[raw.toLowerCase()] ?? null;
}

/** https URL the browser may be sent to. The API does not fetch it. */
export function safeExternalNavigationUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (/[\u0000-\u001F\u007F\\]/.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  url.hash = '';
  return url.href;
}

export function selectModDownloadUrl(
  release: {downloadUrl: string; platformDownloadUrls?: PlatformDownloadUrls | null},
  platform?: ModPlatform,
): string | null {
  if (platform) return release.platformDownloadUrls?.[platform] || release.downloadUrl || null;
  // A platform-specific release requires an explicit choice when there is no common ZIP.
  return release.downloadUrl || null;
}
