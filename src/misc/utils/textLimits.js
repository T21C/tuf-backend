/** Shared caps for user-authored prose. Short names, URLs, and structured blobs keep their own limits. */

export const LARGE_TEXT_MAX = 5000;
/** Discord embed description cap. Truncate posts here; do not use this as an input limit. */
export const DISCORD_DESCRIPTION_MAX = 4000;

/**
 * @typedef {{ ok: true, value: string }} LargeTextOk
 * @typedef {{ ok: false, code: string, message: string, max: number }} LargeTextErr
 * @typedef {LargeTextOk | LargeTextErr} LargeTextResult
 */

/**
 * Trim a large prose field. Rejects overflow instead of silently clipping.
 *
 * @param {unknown} raw
 * @param {{ required?: boolean, label?: string }} [options]
 * @returns {LargeTextResult}
 */
export function parseLargeText(raw, options = {}) {
  const required = options.required === true;
  const label =
    typeof options.label === 'string' && options.label.trim()
      ? options.label.trim()
      : 'Text';
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length > LARGE_TEXT_MAX) {
    return {
      ok: false,
      code: 'length',
      message: `${label} must be at most ${LARGE_TEXT_MAX} characters`,
      max: LARGE_TEXT_MAX,
    };
  }
  if (required && !text) {
    return {
      ok: false,
      code: 'required',
      message: `${label} is required`,
      max: LARGE_TEXT_MAX,
    };
  }
  return {ok: true, value: text};
}

/**
 * Clip assembled Discord embed description text to the API limit.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function clipDiscordDescription(text) {
  const value = text === undefined || text === null ? '' : String(text);
  return value.length <= DISCORD_DESCRIPTION_MAX
    ? value
    : value.slice(0, DISCORD_DESCRIPTION_MAX);
}
