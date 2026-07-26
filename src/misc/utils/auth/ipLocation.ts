// tuf-search: #ipLocation #geoip #auth
import geoip from 'geoip-lite';

function stripIpv4MappedPrefix(ip: string): string {
  return ip.replace(/^::ffff:/i, '');
}

function isPrivateOrLocalIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === 'localhost') {
    return true;
  }
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
    return true;
  }
  if (/^fc/i.test(ip) || /^fd/i.test(ip) || /^fe80:/i.test(ip)) {
    return true;
  }
  return false;
}

function countryDisplayName(countryCode: string): string {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return names.of(countryCode) || countryCode;
  } catch {
    return countryCode;
  }
}

export interface IpLocationInfo {
  /** Human-readable label, e.g. "Vilnius, Lithuania" */
  label: string;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
}

/**
 * Resolve a coarse location for an IP (city / region / country).
 * Private and loopback addresses are labeled as local network.
 */
export function lookupIpLocation(ip: string | null | undefined): IpLocationInfo | null {
  if (!ip || typeof ip !== 'string') return null;
  const cleaned = stripIpv4MappedPrefix(ip.trim());
  if (!cleaned) return null;

  if (isPrivateOrLocalIp(cleaned)) {
    return {
      label: 'Local network',
      city: null,
      region: null,
      country: null,
      countryCode: null,
    };
  }

  const geo = geoip.lookup(cleaned);
  if (!geo) return null;

  const countryCode = geo.country || null;
  const country = countryCode ? countryDisplayName(countryCode) : null;
  const city = geo.city || null;
  const region = geo.region || null;

  const parts: string[] = [];
  if (city) parts.push(city);
  else if (region) parts.push(region);
  if (country) parts.push(country);

  const label = parts.join(', ') || countryCode;
  if (!label) return null;

  return {
    label,
    city,
    region,
    country,
    countryCode,
  };
}
