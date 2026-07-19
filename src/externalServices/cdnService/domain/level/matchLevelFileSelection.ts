/**
 * Resolve a user/API target-level selection against pack chart entries.
 *
 * Prefer exact storage-key / relative-path matches. Basename-only matching is
 * only allowed when the selection has no directory component AND exactly one
 * entry shares that basename — otherwise multi-folder packs with identical
 * names (e.g. `1. Normal/level.adofai` vs `2. Challenge/level.adofai`) would
 * silently resolve to the first list entry.
 */

export type LevelFileSelectionFields = {
    name?: string | null;
    path?: string | null;
    relativePath?: string | null;
};

export function normalizeLevelSelectionPath(value: string): string {
    return String(value).replace(/\\/g, '/').replace(/^\/+/, '');
}

function entryRelativePath(entry: LevelFileSelectionFields): string {
    const raw = entry.relativePath || entry.name || '';
    return normalizeLevelSelectionPath(String(raw));
}

function entryObjectKey(entry: LevelFileSelectionFields): string {
    return normalizeLevelSelectionPath(String(entry.path || ''));
}

function entryBasename(entry: LevelFileSelectionFields): string {
    const rel = entryRelativePath(entry);
    const key = entryObjectKey(entry);
    const fromRel = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    if (fromRel) return fromRel;
    const fromKey = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
    if (fromKey) return fromKey;
    return String(entry.name || '');
}

export function matchLevelFileBySelection<T extends LevelFileSelectionFields>(
    entries: T[],
    selection: string
): T | null {
    if (!Array.isArray(entries) || entries.length === 0) {
        return null;
    }

    const normalizedTarget = normalizeLevelSelectionPath(selection);
    if (!normalizedTarget) {
        return null;
    }

    const isFilenameOnly = !normalizedTarget.includes('/');
    const targetBase = isFilenameOnly
        ? normalizedTarget
        : normalizedTarget.slice(normalizedTarget.lastIndexOf('/') + 1);

    const exact = entries.find((entry) => {
        const objectKey = entryObjectKey(entry);
        const rel = entryRelativePath(entry);
        return objectKey === normalizedTarget || rel === normalizedTarget;
    });
    if (exact) {
        return exact;
    }

    if (!isFilenameOnly) {
        return (
            entries.find((entry) => {
                const objectKey = entryObjectKey(entry);
                const rel = entryRelativePath(entry);
                return (
                    rel.endsWith(`/${normalizedTarget}`) ||
                    objectKey.endsWith(`/${normalizedTarget}`)
                );
            }) ?? null
        );
    }

    const basenameMatches = entries.filter((entry) => entryBasename(entry) === targetBase);
    if (basenameMatches.length === 1) {
        return basenameMatches[0];
    }

    return null;
}
