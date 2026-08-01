/**
 * Detect Elasticsearch HTTP traffic (boot health, index HEAD, _search, sniff, …).
 * Used to suppress Sentry http.client noise while keeping high-level db.elasticsearch spans.
 */
export function isElasticsearchOutgoingUrl(url: string): boolean {
  const raw = url.trim();
  if (!raw) return false;

  const esConfigured = process.env.ELASTICSEARCH_URL?.trim();
  if (esConfigured) {
    try {
      const host = new URL(esConfigured).host;
      if (host && raw.includes(host)) return true;
    } catch {
      // fall through
    }
  }

  // Common local/dev ES ports and API paths when ELASTICSEARCH_URL host matching fails.
  if (/:9200(?:\/|$|\?)/.test(raw)) return true;
  if (/\/_cluster(?:\/|$)/.test(raw)) return true;
  if (/\/_(?:search|msearch|count|bulk|doc|mget|scroll|mapping|aliases)\b/.test(raw)) {
    return true;
  }
  return false;
}

/** Orphan root transactions created by undici/http when ES runs outside a request. */
export function isOrphanElasticsearchClientTransaction(transactionName: string): boolean {
  const name = transactionName.trim();
  // Sentry often normalizes host to https://*/
  if (/^(HEAD|GET|POST|PUT|DELETE)\s+https?:\/\/\*\/?$/i.test(name)) return true;
  if (/^(HEAD|GET|POST|PUT|DELETE)\s+/i.test(name) && isElasticsearchOutgoingUrl(name)) {
    return true;
  }
  return false;
}
