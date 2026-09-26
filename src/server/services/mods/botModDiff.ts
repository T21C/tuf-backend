import {DESCRIPTION_MAX} from './modFields.js';

export const BOT_MOD_DIFF = {
  NOOP: 'noop',
  ADVANCE_URL: 'advance_url',
  CREATE_RELEASE: 'create_release',
  SKIP_EXISTING: 'skip_existing',
  EMPTY_VERSION: 'empty_version',
  MISSING_DOWNLOAD: 'missing_download',
  IGNORE_UPDATE: 'ignore_update',
  DUPLICATE: 'duplicate',
  DISABLED: 'disabled',
  MISSING: 'missing',
} as const;

export type BotModDiffKind = (typeof BOT_MOD_DIFF)[keyof typeof BOT_MOD_DIFF];

export const BOT_MOD_VERSION_MAX = 64;

export function snapshotVersion(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .slice(0, BOT_MOD_VERSION_MAX);
}

export function snapshotDownloadUrl(raw: unknown): string {
  return String(raw ?? '').trim();
}

export function snapshotDescription(raw: unknown): string | null {
  const text =
    typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
  if (!text) return null;
  return text.slice(0, DESCRIPTION_MAX);
}

export type BotModLinkDiffInput = {
  enabled: boolean;
  ignoreUpdate: boolean;
  isDuplicate: boolean;
  missing: boolean;
  version: string | null | undefined;
  parsedDownload: string | null | undefined;
  lastAppliedVersion: string | null | undefined;
  lastAppliedDownloadUrl: string | null | undefined;
  catalogHasVersion: boolean;
};

export function decideBotModGate(
  input: Pick<BotModLinkDiffInput, 'enabled' | 'ignoreUpdate' | 'isDuplicate' | 'missing'>,
): BotModDiffKind | null {
  if (input.missing) return BOT_MOD_DIFF.MISSING;
  if (!input.enabled) return BOT_MOD_DIFF.DISABLED;
  if (input.isDuplicate) return BOT_MOD_DIFF.DUPLICATE;
  if (input.ignoreUpdate) return BOT_MOD_DIFF.IGNORE_UPDATE;
  return null;
}

export function decideBotModReleaseAction(
  input: Pick<
    BotModLinkDiffInput,
    'version' | 'parsedDownload' | 'lastAppliedVersion' | 'lastAppliedDownloadUrl' | 'catalogHasVersion'
  >,
): {kind: BotModDiffKind} {
  const version = snapshotVersion(input.version);
  if (!version) return {kind: BOT_MOD_DIFF.EMPTY_VERSION};

  const downloadUrl = snapshotDownloadUrl(input.parsedDownload);
  if (!downloadUrl) return {kind: BOT_MOD_DIFF.MISSING_DOWNLOAD};

  const cursorVersion = snapshotVersion(input.lastAppliedVersion);
  const cursorUrl = snapshotDownloadUrl(input.lastAppliedDownloadUrl);

  if (input.catalogHasVersion) {
    if (version === cursorVersion) {
      if (downloadUrl === cursorUrl) return {kind: BOT_MOD_DIFF.NOOP};
      return {kind: BOT_MOD_DIFF.ADVANCE_URL};
    }
    return {kind: BOT_MOD_DIFF.SKIP_EXISTING};
  }

  return {kind: BOT_MOD_DIFF.CREATE_RELEASE};
}

export function decideBotModLinkAction(input: BotModLinkDiffInput): {kind: BotModDiffKind} {
  const gate = decideBotModGate(input);
  if (gate) return {kind: gate};
  return decideBotModReleaseAction(input);
}
