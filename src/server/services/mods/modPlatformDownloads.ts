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

export function selectModDownloadUrl(
  release: {downloadUrl: string; platformDownloadUrls?: PlatformDownloadUrls | null},
  platform?: ModPlatform,
): string | null {
  if (platform) return release.platformDownloadUrls?.[platform] || release.downloadUrl || null;
  // A platform-specific release requires an explicit choice when there is no common ZIP.
  return release.downloadUrl || null;
}
