/**
 * Shared heuristics for detecting likely filename mojibake in persisted LEVELZIP `CdnFile.metadata`.
 * Used by {@link ../../scripts/auditLevelzipMojibakeMetadata.ts} and migration / pipeline tooling.
 */

export type MojibakeReason = 'REPLACEMENT_CHAR' | 'SYRIAC_BLOCK' | 'PRIVATE_USE_AREA' | 'C1_CONTROL';

export interface MojibakeStringHit {
    path: string;
    valuePreview: string;
    reasons: MojibakeReason[];
}

const RE_REPLACEMENT = /\uFFFD/;
const RE_SYRIAC = /[\u0700-\u074F]/;
const RE_PUA = /[\uE000-\uF8FF]/;
const RE_C1 = /[\u0080-\u009F]/;

export function scanStringForMojibake(s: string): MojibakeReason[] {
    const reasons = new Set<MojibakeReason>();
    if (RE_REPLACEMENT.test(s)) reasons.add('REPLACEMENT_CHAR');
    if (RE_SYRIAC.test(s)) reasons.add('SYRIAC_BLOCK');
    if (RE_PUA.test(s)) reasons.add('PRIVATE_USE_AREA');
    if (RE_C1.test(s)) reasons.add('C1_CONTROL');
    return [...reasons];
}

const PREVIEW_MAX = 200;

export function previewMojibakeValue(s: string): string {
    const oneLine = s.replace(/\r?\n/g, '⏎');
    if (oneLine.length <= PREVIEW_MAX) return oneLine;
    return `${oneLine.slice(0, PREVIEW_MAX)}…`;
}

/**
 * Walk arbitrary JSON-like metadata: record every string and every object **key** (map keys
 * often hold relative paths in `levelFiles`).
 */
export function collectMetadataStringsForMojibakeAudit(
    value: unknown,
    pathPrefix: string,
    out: { path: string; value: string }[],
    depth: number,
): void {
    if (depth > 30) return;
    if (typeof value === 'string') {
        if (value.length > 0) {
            out.push({ path: pathPrefix || '(root)', value });
        }
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            collectMetadataStringsForMojibakeAudit(value[i], `${pathPrefix}[${i}]`, out, depth + 1);
        }
        return;
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const keyHits = scanStringForMojibake(k);
            if (keyHits.length > 0) {
                out.push({
                    path: pathPrefix ? `${pathPrefix}.__key__:${k}` : `__key__:${k}`,
                    value: `(object key) ${previewMojibakeValue(k)}`,
                });
            }
            const nextPath = pathPrefix ? `${pathPrefix}.${k}` : k;
            collectMetadataStringsForMojibakeAudit(v, nextPath, out, depth + 1);
        }
    }
}

/** Returns non-empty list if any string in `metadata` matches mojibake heuristics. */
export function auditLevelzipMetadataForMojibake(meta: unknown): MojibakeStringHit[] {
    if (!meta || typeof meta !== 'object') return [];
    const leaves: { path: string; value: string }[] = [];
    collectMetadataStringsForMojibakeAudit(meta, '', leaves, 0);
    const hits: MojibakeStringHit[] = [];
    for (const { path, value } of leaves) {
        const reasons = scanStringForMojibake(value);
        if (reasons.length > 0) {
            hits.push({ path, valuePreview: previewMojibakeValue(value), reasons });
        }
    }
    return hits;
}
