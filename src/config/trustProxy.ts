export type TrustProxySetting = false | number | string[];

/**
 * Parse Express' trusted proxy boundary from configuration.
 *
 * Unset/false disables proxy trust. Positive integers represent an exact hop
 * count; comma-separated values represent explicit IPs, CIDRs, or proxy-addr
 * names such as "loopback". The unsafe blanket value "true" is rejected.
 */
export function parseTrustProxySetting(rawValue: string | undefined): TrustProxySetting {
  const value = rawValue?.trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') {
    return false;
  }

  if (value.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true is unsafe; configure an exact hop count or trusted proxy IP/CIDR list',
    );
  }

  if (/^[1-9]\d*$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  const trustedProxies = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  if (trustedProxies.length === 0) {
    return false;
  }

  return trustedProxies;
}
