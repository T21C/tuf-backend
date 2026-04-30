/**
 * Stable signature for metadata fields that affect level cache semantics.
 * Extend the picked object when new metadata drives parse/cache behavior.
 */
export function computeLevelCacheMetadataSignature(metadata: any): string {
    const relevant = {
        targetLevel: metadata?.targetLevel ?? null,
        targetLevelOversized: metadata?.targetLevelOversized ?? false,
        targetSafeToParse: metadata?.targetSafeToParse ?? false,
        targetSafeToParseVersion: metadata?.targetSafeToParseVersion
    };
    return JSON.stringify(relevant, Object.keys(relevant).sort());
}
