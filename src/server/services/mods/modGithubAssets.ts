import axios from 'axios';
import {MOD_PLATFORMS, type ModPlatform, type PlatformDownloadUrls} from './modPlatformDownloads.js';

export function modAssetError(message: string): Error & {status: number} {
  return Object.assign(new Error(message), {status: 400});
}

export function githubReleaseApiUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw modAssetError('Invalid GitHub release URL'); }
  if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw modAssetError('Use an HTTPS github.com release URL');
  const parts = url.pathname.split('/').filter(Boolean);
  const [owner, repo, releases, action] = parts;
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)
    || (releases && releases !== 'releases')) throw modAssetError('Invalid GitHub release URL');
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
  if (!action || action === 'latest') {
    if (parts.length > (action ? 4 : 3)) throw modAssetError('Invalid GitHub release URL');
    return `${base}/latest`;
  }
  if (!['tag', 'download'].includes(action) || !parts[4]) throw modAssetError('Use a GitHub release tag or download URL');
  // GitHub tags may contain slashes; download URLs have a final asset filename.
  const tagParts = action === 'download' ? parts.slice(4, -1) : parts.slice(4);
  if (!tagParts.length) throw modAssetError('Invalid GitHub release tag');
  let tag: string;
  try { tag = decodeURIComponent(tagParts.join('/')); } catch { throw modAssetError('Invalid GitHub release tag'); }
  return `${base}/tags/${encodeURIComponent(tag)}`;
}

export function detectModZipPlatform(name: string): ModPlatform | 'common' | null {
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  if (/(?:^|[._\s-])(?:source|sources|src|symbols|pdb|debug)(?:[._\s-]|$)/.test(normalized)) return null;
  const patterns: Record<ModPlatform, RegExp> = {
    windows: /(?:^|[._\s-])(?:windows|win(?:32|64)?)(?:[._\s-]|$)/,
    macos: /(?:^|[._\s-])(?:mac(?:os)?|osx|os-x|darwin)(?:[._\s-]|$)/,
    linux: /(?:^|[._\s-])(?:linux|ubuntu)(?:[._\s-]|$)/,
  };
  const matches = MOD_PLATFORMS.filter((platform) => patterns[platform].test(normalized));
  return matches.length > 1 ? null : matches[0] ?? 'common';
}

export function classifyGithubReleaseAssets(data: {
  tag_name?: string; html_url?: string;
  assets?: {name?: string; browser_download_url?: string; size?: number}[];
}) {
  const assets = (Array.isArray(data.assets) ? data.assets : []).flatMap((asset) => {
    if (!asset || typeof asset.name !== 'string' || !/\.zip$/i.test(asset.name)
      || typeof asset.browser_download_url !== 'string') return [];
    try {
      const url = new URL(asset.browser_download_url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
        || !/\/releases\/download\/.+\.zip$/i.test(url.pathname)) return [];
    } catch { return []; }
    return [{name: asset.name, url: asset.browser_download_url, size: asset.size ?? 0,
      platform: detectModZipPlatform(asset.name)}];
  });
  const platformDownloadUrls: PlatformDownloadUrls = {};
  for (const platform of MOD_PLATFORMS) {
    const candidates = assets.filter((asset) => asset.platform === platform);
    if (candidates.length === 1) platformDownloadUrls[platform] = candidates[0].url;
  }
  const common = assets.filter((asset) => asset.platform === 'common');
  return {githubUrl: data.html_url ?? '', version: data.tag_name ?? '', assets,
    downloadUrl: common.length === 1 ? common[0].url : '', platformDownloadUrls};
}

export async function fetchGithubReleaseAssets(githubUrl: string) {
  const url = githubReleaseApiUrl(githubUrl);
  try {
    const {data} = await axios.get(url, {
      timeout: 15000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
      headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'TUF-Mod-Catalog',
        'X-GitHub-Api-Version': '2022-11-28'},
    });
    if (!data || typeof data !== 'object' || !Array.isArray(data.assets)) {
      throw modAssetError('Invalid GitHub release response');
    }
    const result = classifyGithubReleaseAssets(data);
    if (!result.assets.length) throw modAssetError('This GitHub release has no ZIP assets');
    return result;
  } catch (error) {
    if ((error as {status?: number}).status === 400) throw error;
    if (axios.isAxiosError(error) && [403, 429].includes(error.response?.status ?? 0)) {
      throw modAssetError('GitHub rate limit reached. Try again later or enter ZIP URLs manually');
    }
    throw modAssetError('Unable to load the GitHub release. Check the URL or enter ZIP URLs manually');
  }
}
