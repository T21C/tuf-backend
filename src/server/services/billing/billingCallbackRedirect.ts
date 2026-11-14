/**
 * Allow a billing return hop only when the destination origin is already trusted.
 * Rejects non-http schemes, credentialed URLs, and off-site hosts.
 */
export function billingCallbackRedirectTarget(
  raw: unknown,
  isAllowedOrigin: (origin: string) => boolean,
): string | null {
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

  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:') {
    if (host !== 'localhost' && host !== '127.0.0.1') return null;
  } else if (url.protocol !== 'https:') {
    return null;
  }
  if (!isAllowedOrigin(url.origin)) return null;
  return url.href;
}
