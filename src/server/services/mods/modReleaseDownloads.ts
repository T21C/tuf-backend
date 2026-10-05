import {parseModZipUrl, type ModReleaseFields} from './modFields.js';
import type {PlatformDownloadUrls} from './modPlatformDownloads.js';
import {fetchGithubReleaseAssets, modAssetError} from './modGithubAssets.js';

export async function resolveExternalReleaseUrls(
  parsed: Partial<ModReleaseFields>,
  previous?: {downloadUrl: string; platformDownloadUrls?: PlatformDownloadUrls | null},
): Promise<{downloadUrl: string; platformDownloadUrls: PlatformDownloadUrls | null; uploadedUrl?: string}> {
  // Legacy clients sending only githubUrl now resolve actual release ZIPs.
  if (parsed.githubUrl && parsed.downloadUrl === undefined && parsed.platformDownloadUrls === undefined) {
    // A direct asset URL already identifies the desired file, even on multi-asset releases.
    if (/\/releases\/download\/.+\.zip$/i.test(new URL(parsed.githubUrl).pathname)) {
      const url = parseModZipUrl(parsed.githubUrl, 'githubUrl');
      if (!url.ok) throw modAssetError(url.error);
      return {downloadUrl: parsed.githubUrl, platformDownloadUrls: null};
    }
    const assets = await fetchGithubReleaseAssets(parsed.githubUrl);
    if (!assets.downloadUrl && !Object.keys(assets.platformDownloadUrls).length) {
      throw modAssetError('Multiple ZIP assets found. Choose ZIP URLs explicitly');
    }
    return {downloadUrl: assets.downloadUrl, platformDownloadUrls: assets.platformDownloadUrls};
  }
  const downloadUrl = parsed.downloadUrl ?? previous?.downloadUrl ?? '';
  const platformDownloadUrls = parsed.platformDownloadUrls !== undefined
    ? parsed.platformDownloadUrls : previous?.platformDownloadUrls ?? null;
  if (!downloadUrl && !Object.keys(platformDownloadUrls ?? {}).length) {
    throw modAssetError('Provide at least one ZIP download URL');
  }
  return {downloadUrl, platformDownloadUrls};
}
