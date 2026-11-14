const IMAGE_EXT = /\.(png|jpe?g|webp|gif|apng|bmp|ico|icon|heic|heif|avif|tiff?)$/i;

function isBilibiliImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'hdslb.com'
    || host.endsWith('.hdslb.com')
    || host === 'biliimg.com'
    || host.endsWith('.biliimg.com');
}

function hasImagePath(pathname: string): boolean {
  const withoutStyle = pathname.replace(/@[^/]*$/, '');
  return IMAGE_EXT.test(pathname) || IMAGE_EXT.test(withoutStyle);
}

/** https URL on Bilibili's image CDNs, or null when the proxy must refuse it. */
export function normalizeBilibiliImageUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return null;
  if (url.port && url.port !== '443') return null;
  if (!isBilibiliImageHost(url.hostname) || !hasImagePath(url.pathname)) return null;
  url.hash = '';
  return url.href;
}

/** Follow a redirect only when the next hop is still a Bilibili image URL. */
export function resolveBilibiliImageRedirect(current: string, location: string): string | null {
  let next: string;
  try {
    next = new URL(location, current).href;
  } catch {
    return null;
  }
  return normalizeBilibiliImageUrl(next);
}
