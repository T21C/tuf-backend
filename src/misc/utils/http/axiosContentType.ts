/**
 * Axios types `Content-Type` as a wide union (string | string[] | number | AxiosHeaders, etc.).
 * Call sites that need `string` (Express headers, `startsWith`, etc.) should use this helper.
 */
export function coalesceAxiosContentTypeHeader(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      if (typeof part === 'string') {
        const trimmed = part.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }
  return undefined;
}
