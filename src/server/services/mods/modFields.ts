export const NAME_MAX = 512;
export const USERNAME_MAX = 64;
export const DISCORD_ID_MAX = 32;
export const VERSION_MAX = 64;
export const DESCRIPTION_MAX = 16384;
export const URL_MAX = 2048;

export type ParseResult<T> = {ok: true; value: T} | {ok: false; error: string};

export type ModCreateFields = {
  name: string;
  creatorUsername: string;
  creatorDiscordId: string;
  version: string | null;
  description: string | null;
  downloadUrl: string;
  imageUrl: string | null;
  projectUrl: string | null;
  deprecatedAfter: string | null;
  sourceUploadedAt: Date;
  hidden: boolean;
  isPinned: boolean;
  slug: string | null;
};

export type ModPatchFields = Partial<ModCreateFields>;

function optionalText(raw: unknown, max: number): ParseResult<string | null> {
  if (raw === null || raw === undefined) return {ok: true, value: null};
  if (typeof raw !== 'string') return {ok: false, error: 'Invalid text field'};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: true, value: null};
  if (trimmed.length > max) {
    return {ok: false, error: `Must be at most ${max} characters`};
  }
  return {ok: true, value: trimmed};
}

function requiredText(raw: unknown, label: string, max: number): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: `${label} is required`};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: false, error: `${label} is required`};
  if (trimmed.length > max) return {ok: false, error: `${label} is too long`};
  return {ok: true, value: trimmed};
}

export function parseHttpUrl(raw: unknown, label = 'url'): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: `${label} is required`};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: false, error: `${label} is required`};
  if (trimmed.length > URL_MAX) return {ok: false, error: `${label} is too long`};
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return {ok: false, error: `${label} must be http or https`};
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {ok: false, error: `${label} must be http or https`};
    }
    if (parsed.username || parsed.password) {
      return {ok: false, error: `${label} must not include credentials`};
    }
    return {ok: true, value: parsed.href};
  } catch {
    return {ok: false, error: `${label} is invalid`};
  }
}

export function parseOptionalHttpUrl(raw: unknown, label: string): ParseResult<string | null> {
  if (raw === null || raw === undefined) return {ok: true, value: null};
  if (typeof raw !== 'string') return {ok: false, error: `${label} is invalid`};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: true, value: null};
  return parseHttpUrl(trimmed, label);
}

export function isGithubHostedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

export function parseGithubImageUrl(raw: unknown): ParseResult<string | null> {
  if (raw === null || raw === undefined) return {ok: true, value: null};
  if (typeof raw !== 'string') return {ok: false, error: 'imageUrl is invalid'};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: true, value: null};
  const parsed = parseHttpUrl(trimmed, 'imageUrl');
  if (!parsed.ok) return parsed;
  if (!isGithubHostedUrl(parsed.value)) {
    return {ok: false, error: 'imageUrl must be hosted on GitHub'};
  }
  return {ok: true, value: parsed.value};
}

export function parseDiscordSnowflake(raw: unknown): ParseResult<string> {
  const asString =
    typeof raw === 'number' && Number.isInteger(raw) && raw > 0
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (!asString) return {ok: false, error: 'creatorDiscordId is required'};
  if (!/^\d{5,32}$/.test(asString)) {
    return {ok: false, error: 'creatorDiscordId must be a Discord snowflake'};
  }
  return {ok: true, value: asString};
}

export function parseSourceUploadedAt(raw: unknown, required: boolean): ParseResult<Date | undefined> {
  if (raw === null || raw === undefined || raw === '') {
    if (required) return {ok: true, value: new Date()};
    return {ok: true, value: undefined};
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return {ok: true, value: raw};
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return {ok: false, error: 'sourceUploadedAt is invalid'};
    return {ok: true, value: date};
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (required) return {ok: true, value: new Date()};
      return {ok: true, value: undefined};
    }
    if (/^\d+$/.test(trimmed)) {
      return parseSourceUploadedAt(Number(trimmed), required);
    }
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return {ok: false, error: 'sourceUploadedAt is invalid'};
    return {ok: true, value: date};
  }
  return {ok: false, error: 'sourceUploadedAt is invalid'};
}

function parseHidden(raw: unknown, fallback: boolean): ParseResult<boolean> {
  if (raw === undefined) return {ok: true, value: fallback};
  if (typeof raw === 'boolean') return {ok: true, value: raw};
  if (raw === 0 || raw === '0' || raw === 'false') return {ok: true, value: false};
  if (raw === 1 || raw === '1' || raw === 'true') return {ok: true, value: true};
  return {ok: false, error: 'hidden must be a boolean'};
}

function parseBooleanField(raw: unknown, label: string, fallback: boolean): ParseResult<boolean> {
  if (raw === undefined) return {ok: true, value: fallback};
  if (typeof raw === 'boolean') return {ok: true, value: raw};
  if (raw === 0 || raw === '0' || raw === 'false') return {ok: true, value: false};
  if (raw === 1 || raw === '1' || raw === 'true') return {ok: true, value: true};
  return {ok: false, error: `${label} must be a boolean`};
}

export function parseModSlug(raw: unknown, required: boolean): ParseResult<string | null> {
  if (raw === undefined || raw === null || raw === '') {
    if (required) return {ok: false, error: 'slug is required'};
    return {ok: true, value: null};
  }
  if (typeof raw !== 'string') return {ok: false, error: 'slug is invalid'};
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    if (required) return {ok: false, error: 'slug is required'};
    return {ok: true, value: null};
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed) || trimmed.length > 80) {
    return {ok: false, error: 'slug must be lowercase letters, numbers, and hyphens'};
  }
  return {ok: true, value: trimmed};
}

export function parseVersionLabel(raw: unknown, required: boolean): ParseResult<string> {
  if (raw === undefined || raw === null || raw === '') {
    if (required) return {ok: false, error: 'version is required'};
    return {ok: true, value: 'unspecified'};
  }
  if (typeof raw !== 'string') return {ok: false, error: 'version is invalid'};
  const trimmed = raw.trim();
  if (!trimmed) {
    if (required) return {ok: false, error: 'version is required'};
    return {ok: true, value: 'unspecified'};
  }
  if (trimmed.length > VERSION_MAX) return {ok: false, error: 'version is too long'};
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return {ok: false, error: 'version must not contain slashes'};
  }
  return {ok: true, value: trimmed};
}

export function parseHexColor(raw: unknown, fallback = '#8d70ff'): ParseResult<string> {
  if (raw === undefined || raw === null || raw === '') return {ok: true, value: fallback};
  if (typeof raw !== 'string') return {ok: false, error: 'color is invalid'};
  const trimmed = raw.trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return {ok: false, error: 'color must be a hex value'};
  return {ok: true, value: trimmed.toLowerCase()};
}

export function parseTagIds(raw: unknown): ParseResult<number[]> {
  if (!Array.isArray(raw)) return {ok: false, error: 'tagIds must be an array'};
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n <= 0) return {ok: false, error: 'tagIds must be positive integers'};
    if (!seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  return {ok: true, value: ids};
}

export function parseModCreate(body: unknown): ParseResult<ModCreateFields> {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if ('imageUrl' in src) return {ok: false, error: 'Cannot update this field'};
  const name = requiredText(src.name, 'name', NAME_MAX);
  if (!name.ok) return name;
  const creatorUsername = requiredText(src.creatorUsername, 'creatorUsername', USERNAME_MAX);
  if (!creatorUsername.ok) return creatorUsername;
  const creatorDiscordId = parseDiscordSnowflake(src.creatorDiscordId);
  if (!creatorDiscordId.ok) return creatorDiscordId;
  const version = optionalText(src.version, VERSION_MAX);
  if (!version.ok) return version;
  const description = optionalText(src.description, DESCRIPTION_MAX);
  if (!description.ok) return description;
  const downloadUrl = parseHttpUrl(src.downloadUrl, 'downloadUrl');
  if (!downloadUrl.ok) return downloadUrl;
  const projectUrl = parseOptionalHttpUrl(src.projectUrl, 'projectUrl');
  if (!projectUrl.ok) return projectUrl;
  const deprecatedAfter = optionalText(src.deprecatedAfter, VERSION_MAX);
  if (!deprecatedAfter.ok) return deprecatedAfter;
  const sourceUploadedAt = parseSourceUploadedAt(src.sourceUploadedAt, true);
  if (!sourceUploadedAt.ok) return sourceUploadedAt;
  const hidden = parseHidden(src.hidden, false);
  if (!hidden.ok) return hidden;
  const isPinned = parseBooleanField(src.isPinned, 'isPinned', false);
  if (!isPinned.ok) return isPinned;
  const slug = parseModSlug(src.slug, false);
  if (!slug.ok) return slug;

  return {
    ok: true,
    value: {
      name: name.value,
      creatorUsername: creatorUsername.value,
      creatorDiscordId: creatorDiscordId.value,
      version: version.value,
      description: description.value,
      downloadUrl: downloadUrl.value,
      imageUrl: null,
      projectUrl: projectUrl.value,
      deprecatedAfter: deprecatedAfter.value,
      sourceUploadedAt: sourceUploadedAt.value as Date,
      hidden: hidden.value,
      isPinned: isPinned.value,
      slug: slug.value,
    },
  };
}

export function parseModPatch(body: unknown): ParseResult<ModPatchFields> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, error: 'Invalid body'};
  }
  const src = body as Record<string, unknown>;
  if ('imageUrl' in src) return {ok: false, error: 'Cannot update this field'};
  const value: ModPatchFields = {};

  if (src.name !== undefined) {
    const name = requiredText(src.name, 'name', NAME_MAX);
    if (!name.ok) return name;
    value.name = name.value;
  }
  if (src.creatorUsername !== undefined) {
    const creatorUsername = requiredText(src.creatorUsername, 'creatorUsername', USERNAME_MAX);
    if (!creatorUsername.ok) return creatorUsername;
    value.creatorUsername = creatorUsername.value;
  }
  if (src.creatorDiscordId !== undefined) {
    const creatorDiscordId = parseDiscordSnowflake(src.creatorDiscordId);
    if (!creatorDiscordId.ok) return creatorDiscordId;
    value.creatorDiscordId = creatorDiscordId.value;
  }
  if (src.version !== undefined) {
    const version = optionalText(src.version, VERSION_MAX);
    if (!version.ok) return version;
    value.version = version.value;
  }
  if (src.description !== undefined) {
    const description = optionalText(src.description, DESCRIPTION_MAX);
    if (!description.ok) return description;
    value.description = description.value;
  }
  if (src.downloadUrl !== undefined) {
    const downloadUrl = parseHttpUrl(src.downloadUrl, 'downloadUrl');
    if (!downloadUrl.ok) return downloadUrl;
    value.downloadUrl = downloadUrl.value;
  }
  if (src.projectUrl !== undefined) {
    const projectUrl = parseOptionalHttpUrl(src.projectUrl, 'projectUrl');
    if (!projectUrl.ok) return projectUrl;
    value.projectUrl = projectUrl.value;
  }
  if (src.deprecatedAfter !== undefined) {
    const deprecatedAfter = optionalText(src.deprecatedAfter, VERSION_MAX);
    if (!deprecatedAfter.ok) return deprecatedAfter;
    value.deprecatedAfter = deprecatedAfter.value;
  }
  if (src.sourceUploadedAt !== undefined) {
    const sourceUploadedAt = parseSourceUploadedAt(src.sourceUploadedAt, false);
    if (!sourceUploadedAt.ok) return sourceUploadedAt;
    if (sourceUploadedAt.value) value.sourceUploadedAt = sourceUploadedAt.value;
  }
  if (src.hidden !== undefined) {
    const hidden = parseHidden(src.hidden, false);
    if (!hidden.ok) return hidden;
    value.hidden = hidden.value;
  }
  if (src.isPinned !== undefined) {
    const isPinned = parseBooleanField(src.isPinned, 'isPinned', false);
    if (!isPinned.ok) return isPinned;
    value.isPinned = isPinned.value;
  }
  if (src.slug !== undefined) {
    const slug = parseModSlug(src.slug, false);
    if (!slug.ok) return slug;
    value.slug = slug.value;
  }

  if (Object.keys(value).length === 0) {
    return {ok: false, error: 'No fields to update'};
  }
  return {ok: true, value};
}

const ASSIGNEE_FORBIDDEN_FIELDS = new Set([
  'hidden',
  'creatorUsername',
  'creatorDiscordId',
  'imageUrl',
  'isPinned',
  'slug',
  'version',
  'downloadUrl',
  'sourceUploadedAt',
]);

export type ModAssigneePatchFields = Pick<
  ModPatchFields,
  'name' | 'description' | 'projectUrl' | 'deprecatedAfter'
>;

export function parsePlayerId(raw: unknown): ParseResult<number> {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return {ok: true, value: raw};
  }
  if (typeof raw === 'string' && /^\d{1,20}$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isInteger(parsed) && parsed > 0) return {ok: true, value: parsed};
  }
  return {ok: false, error: 'playerId is required'};
}

export function parseAssignAssigneesBody(
  body: unknown,
): ParseResult<{playerId: number; applyToSameCreator: boolean}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, error: 'Invalid body'};
  }
  const src = body as Record<string, unknown>;
  const playerId = parsePlayerId(src.playerId);
  if (!playerId.ok) return playerId;
  const applyRaw = src.applyToSameCreator;
  let applyToSameCreator = false;
  if (applyRaw !== undefined) {
    if (typeof applyRaw === 'boolean') applyToSameCreator = applyRaw;
    else if (applyRaw === 1 || applyRaw === '1' || applyRaw === 'true') applyToSameCreator = true;
    else if (applyRaw === 0 || applyRaw === '0' || applyRaw === 'false') applyToSameCreator = false;
    else return {ok: false, error: 'applyToSameCreator must be a boolean'};
  }
  return {ok: true, value: {playerId: playerId.value, applyToSameCreator}};
}

export function parseModAssigneePatch(body: unknown): ParseResult<ModAssigneePatchFields> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, error: 'Invalid body'};
  }
  const src = body as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (ASSIGNEE_FORBIDDEN_FIELDS.has(key)) {
      return {ok: false, error: 'Cannot update this field'};
    }
  }

  const value: ModAssigneePatchFields = {};
  if (src.name !== undefined) {
    const name = requiredText(src.name, 'name', NAME_MAX);
    if (!name.ok) return name;
    value.name = name.value;
  }
  if (src.description !== undefined) {
    const description = optionalText(src.description, DESCRIPTION_MAX);
    if (!description.ok) return description;
    value.description = description.value;
  }
  if (src.projectUrl !== undefined) {
    const projectUrl = parseOptionalHttpUrl(src.projectUrl, 'projectUrl');
    if (!projectUrl.ok) return projectUrl;
    value.projectUrl = projectUrl.value;
  }
  if (src.deprecatedAfter !== undefined) {
    const deprecatedAfter = optionalText(src.deprecatedAfter, VERSION_MAX);
    if (!deprecatedAfter.ok) return deprecatedAfter;
    value.deprecatedAfter = deprecatedAfter.value;
  }

  if (Object.keys(value).length === 0) {
    return {ok: false, error: 'No fields to update'};
  }
  return {ok: true, value};
}

export type ModVersionFields = {
  version: string;
  downloadUrl: string;
  notes: string | null;
  releasedAt: Date;
};

export function parseModVersionBody(
  body: unknown,
  options?: {partial?: boolean},
): ParseResult<Partial<ModVersionFields> | ModVersionFields> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, error: 'Invalid body'};
  }
  const src = body as Record<string, unknown>;
  const partial = Boolean(options?.partial);
  const value: Partial<ModVersionFields> = {};

  if (!partial || src.version !== undefined) {
    const version = parseVersionLabel(src.version, !partial);
    if (!version.ok) return version;
    value.version = version.value;
  }
  if (!partial || src.downloadUrl !== undefined) {
    const downloadUrl = parseHttpUrl(src.downloadUrl, 'downloadUrl');
    if (!downloadUrl.ok) return downloadUrl;
    value.downloadUrl = downloadUrl.value;
  }
  if (!partial || src.notes !== undefined) {
    const notes = optionalText(src.notes, DESCRIPTION_MAX);
    if (!notes.ok) return notes;
    value.notes = notes.value;
  }
  if (!partial || src.releasedAt !== undefined || src.sourceUploadedAt !== undefined) {
    const releasedAt = parseSourceUploadedAt(src.releasedAt ?? src.sourceUploadedAt, !partial);
    if (!releasedAt.ok) return releasedAt;
    if (releasedAt.value) value.releasedAt = releasedAt.value;
  }

  if (partial && Object.keys(value).length === 0) {
    return {ok: false, error: 'No fields to update'};
  }
  return {ok: true, value};
}

export function parseModTagBody(
  body: unknown,
  options?: {partial?: boolean},
): ParseResult<{name?: string; color?: string; sortOrder?: number}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, error: 'Invalid body'};
  }
  const src = body as Record<string, unknown>;
  const partial = Boolean(options?.partial);
  const value: {name?: string; color?: string; sortOrder?: number} = {};
  if (!partial || src.name !== undefined) {
    const name = requiredText(src.name, 'name', 64);
    if (!name.ok) return name;
    value.name = name.value;
  }
  if (!partial || src.color !== undefined) {
    const color = parseHexColor(src.color);
    if (!color.ok) return color;
    value.color = color.value;
  }
  if (src.sortOrder !== undefined) {
    const n = typeof src.sortOrder === 'number' ? src.sortOrder : Number(src.sortOrder);
    if (!Number.isInteger(n)) return {ok: false, error: 'sortOrder must be an integer'};
    value.sortOrder = n;
  }
  if (partial && Object.keys(value).length === 0) {
    return {ok: false, error: 'No fields to update'};
  }
  return {ok: true, value};
}

export function parseMergeBody(body: unknown): ParseResult<{sourceModId: number}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {ok: false, error: 'Invalid body'};
  }
  const src = body as Record<string, unknown>;
  const sourceModId = parsePlayerId(src.sourceModId);
  if (!sourceModId.ok) return {ok: false, error: 'sourceModId is required'};
  return {ok: true, value: {sourceModId: sourceModId.value}};
}

