/**
 * Historically this file housed a hex-decoder for filenames that were shipped over the wire
 * as `[0-9a-f]+`. All new uploads carry UTF-8 directly (NFC-normalised); the hex round-trip is
 * gone from the client.
 *
 * We keep a forgiving `normaliseOriginalFilename` helper for the legacy ingestion path:
 *   - Detects a purely-hex string and tries to decode it as UTF-8. If the decoded result has
 *     any character outside Unicode + looks "reasonable" (no NUL, has a dot or letters) we
 *     return it; otherwise we fall through to the raw value.
 *   - Applies NFC normalisation either way so downstream on-disk + R2 filenames are consistent.
 *
 * Delete once every in-flight upload has been re-submitted under the new chunked flow.
 */

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

function looksLikeHexFilename(value: string): boolean {
    return value.length >= 8 && value.length % 2 === 0 && HEX_PATTERN.test(value);
}

function tryDecodeHex(value: string): string | null {
    const bytes = new Uint8Array(value.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (decoded.indexOf('\u0000') !== -1) return null;
        if (!/[.\p{L}]/u.test(decoded)) return null;
        return decoded;
    } catch {
        return null;
    }
}

export const normaliseOriginalFilename = (raw: string): string => {
    if (!raw) return raw;
    if (looksLikeHexFilename(raw)) {
        const decoded = tryDecodeHex(raw);
        if (decoded) return decoded.normalize('NFC');
    }
    return raw.normalize('NFC');
};

/**
 * @deprecated Use {@link normaliseOriginalFilename}. Alias preserved so existing call sites
 * continue to compile while they migrate.
 */
export const decodeFilename = normaliseOriginalFilename;
