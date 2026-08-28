export const TITLE_MAX = 255;
export const URL_MAX = 2048;
export const DESCRIPTION_MAX = 2000;
export const SHORTHAND_MAX = 64;
export const GROUP_NAME_MAX = 64;
export const TAG_GROUP_NAME_MAX = GROUP_NAME_MAX;

export type UsefulLinkFields = {
  title: string;
  url: string;
  description: string | null;
  shorthand: string | null;
  groupIds?: number[];
};

export type UsefulLinkLocaleFields = {
  languageCode: string;
  title: string;
  url: string;
  description: string | null;
  shorthand: string | null;
};

export type ParseResult<T> = {ok: true; value: T} | {ok: false; error: string};

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

export function parseHttpUrl(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: 'url is required'};
  const trimmed = raw.trim();
  if (!trimmed) return {ok: false, error: 'url is required'};
  if (trimmed.length > URL_MAX) return {ok: false, error: 'url is too long'};
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return {ok: false, error: 'url must be http or https'};
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {ok: false, error: 'url must be http or https'};
    }
    if (parsed.username || parsed.password) {
      return {ok: false, error: 'url must not include credentials'};
    }
    return {ok: true, value: parsed.href};
  } catch {
    return {ok: false, error: 'url is invalid'};
  }
}

export function parseGroupName(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: 'Group name is required'};
  const name = raw.trim();
  if (!name) return {ok: false, error: 'Group name is required'};
  if (name.length > GROUP_NAME_MAX) {
    return {ok: false, error: 'Group name is too long'};
  }
  return {ok: true, value: name};
}

export const parseTagGroupName = parseGroupName;

export function parseGroupIds(raw: unknown): ParseResult<number[] | undefined> {
  if (raw === undefined) return {ok: true, value: undefined};
  if (raw === null) return {ok: true, value: []};
  if (!Array.isArray(raw)) return {ok: false, error: 'groupIds must be an array'};
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of raw) {
    const n = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(n) || n <= 0) {
      return {ok: false, error: 'Invalid groupId'};
    }
    if (seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  return {ok: true, value: ids};
}

export const parseTagIds = parseGroupIds;

export function parseUsefulLinkCreate(body: unknown): ParseResult<UsefulLinkFields> {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const titleRaw = typeof src.title === 'string' ? src.title.trim() : '';
  if (!titleRaw) return {ok: false, error: 'title is required'};
  if (titleRaw.length > TITLE_MAX) return {ok: false, error: 'title is too long'};

  const url = parseHttpUrl(src.url);
  if (!url.ok) return url;

  const description = optionalText(src.description, DESCRIPTION_MAX);
  if (!description.ok) return description;

  const shorthand = optionalText(src.shorthand, SHORTHAND_MAX);
  if (!shorthand.ok) return shorthand;

  const groupIds = parseGroupIds(src.groupIds ?? src.tagIds);
  if (!groupIds.ok) return groupIds;

  return {
    ok: true,
    value: {
      title: titleRaw,
      url: url.value,
      description: description.value,
      shorthand: shorthand.value,
      groupIds: groupIds.value ?? [],
    },
  };
}

export function parseUsefulLinkPatch(
  body: unknown,
): ParseResult<Partial<UsefulLinkFields>> {
  if (!body || typeof body !== 'object') {
    return {ok: false, error: 'Request body is required'};
  }
  const src = body as Record<string, unknown>;
  const updates: Partial<UsefulLinkFields> = {};

  if (src.title !== undefined) {
    if (typeof src.title !== 'string') return {ok: false, error: 'title is invalid'};
    const title = src.title.trim();
    if (!title) return {ok: false, error: 'title is required'};
    if (title.length > TITLE_MAX) return {ok: false, error: 'title is too long'};
    updates.title = title;
  }

  if (src.url !== undefined) {
    const url = parseHttpUrl(src.url);
    if (!url.ok) return url;
    updates.url = url.value;
  }

  if (src.description !== undefined) {
    const description = optionalText(src.description, DESCRIPTION_MAX);
    if (!description.ok) return description;
    updates.description = description.value;
  }

  if (src.shorthand !== undefined) {
    const shorthand = optionalText(src.shorthand, SHORTHAND_MAX);
    if (!shorthand.ok) return shorthand;
    updates.shorthand = shorthand.value;
  }

  if (src.groupIds !== undefined || src.tagIds !== undefined) {
    const groupIds = parseGroupIds(src.groupIds ?? src.tagIds);
    if (!groupIds.ok) return groupIds;
    updates.groupIds = groupIds.value ?? [];
  }

  if (!Object.keys(updates).length) {
    return {ok: false, error: 'No fields to update'};
  }

  return {ok: true, value: updates};
}

export type SortOrderItem = {id: number; sortOrder: number};

export function parseSortOrders(value: unknown): SortOrderItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const items: SortOrderItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const src = raw as Record<string, unknown>;
    const id = Number(src.id);
    const sortOrder = Number(src.sortOrder);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    if (!Number.isInteger(sortOrder)) continue;
    seen.add(id);
    items.push({id, sortOrder});
  }
  return items;
}

export function parseOrderedIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  return ids;
}

export type GroupAssignmentSnapshot = {id: number; linkIds: number[]};

export function parseGroupAssignmentSnapshot(raw: unknown): ParseResult<GroupAssignmentSnapshot[]> {
  if (!Array.isArray(raw)) return {ok: false, error: 'groups must be an array'};
  const seenGroups = new Set<number>();
  const groups: GroupAssignmentSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return {ok: false, error: 'Invalid group assignment'};
    }
    const src = item as Record<string, unknown>;
    const id = Number(src.id);
    if (!Number.isInteger(id) || id <= 0 || seenGroups.has(id)) {
      return {ok: false, error: 'Invalid group id'};
    }
    seenGroups.add(id);
    groups.push({id, linkIds: parseOrderedIds(src.linkIds)});
  }
  return {ok: true, value: groups};
}

export function mergeOrderedIds(requested: number[], existingIds: number[]): number[] {
  const existing = new Set(existingIds);
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const id of requested) {
    if (!existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of existingIds) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

export function parseTitle(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') return {ok: false, error: 'title is required'};
  const title = raw.trim();
  if (!title) return {ok: false, error: 'title is required'};
  if (title.length > TITLE_MAX) return {ok: false, error: 'title is too long'};
  return {ok: true, value: title};
}

export function parseLocaleFields(
  body: unknown,
): ParseResult<UsefulLinkLocaleFields> {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const languageCode =
    typeof src.languageCode === 'string' ? src.languageCode.trim().toLowerCase() : '';
  if (!languageCode) return {ok: false, error: 'languageCode is required'};
  if (languageCode.length > 8) return {ok: false, error: 'languageCode is invalid'};

  const title = parseTitle(src.title);
  if (!title.ok) return title;
  const url = parseHttpUrl(src.url);
  if (!url.ok) return url;
  const description = optionalText(src.description, DESCRIPTION_MAX);
  if (!description.ok) return description;
  const shorthand = optionalText(src.shorthand, SHORTHAND_MAX);
  if (!shorthand.ok) return shorthand;

  return {
    ok: true,
    value: {
      languageCode,
      title: title.value,
      url: url.value,
      description: description.value,
      shorthand: shorthand.value,
    },
  };
}
