/** Same jump-link shape as discordJumpTarget in discordWebhook.ts. */
const DISCORD_JUMP_URL = /discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+/i;
const ANNOUNCEMENT_THREAD_WINDOW_MS = 60 * 60 * 1000;

function timestampMs(value: Date | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** True when the settled rating belongs to this announcement queue row. */
export function ratingMatchesAnnouncementWindow(
  confirmedAt: Date | string | null | undefined,
  queueCreatedAt: Date | string | null | undefined,
): boolean {
  const confirmedMs = timestampMs(confirmedAt);
  const queuedMs = timestampMs(queueCreatedAt);
  if (confirmedMs == null || queuedMs == null) return false;
  return Math.abs(confirmedMs - queuedMs) <= ANNOUNCEMENT_THREAD_WINDOW_MS;
}

export function rerateAnnouncementThreadUrl(options: {
  ratingUrl?: string | null;
  requestUrl?: string | null;
  immediateSettle?: boolean | null;
  requestStatus?: string | null;
}): string | null {
  const requestOwnsThread = Boolean(
    options.requestUrl
    || options.immediateSettle
    || options.requestStatus === 'discord_vote',
  );
  const url = (requestOwnsThread ? options.requestUrl : null) || options.ratingUrl || null;
  if (!url || !DISCORD_JUMP_URL.test(url)) return null;
  return url;
}
