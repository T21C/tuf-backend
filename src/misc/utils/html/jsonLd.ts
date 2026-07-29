/**
 * Serialisation helper for JSON-LD blocks that get inlined into server-rendered
 * HTML (`src/server/middleware/html-meta.ts`).
 *
 * Kept in its own module — free of model/config imports — so the escaping rule
 * can be unit tested without booting Sequelize.
 */

/**
 * Escape a `JSON.stringify` result so it is safe inside
 * `<script type="application/ld+json"> … </script>`.
 *
 * `JSON.stringify` escapes nothing the HTML tokenizer cares about, so a value
 * containing `</script>` closes the block early and everything after it is
 * parsed as markup. Not every value that reaches the JSON-LD blocks is trusted:
 * `pass.videoLink` is stored verbatim whenever it fails to match a known
 * YouTube/Bilibili pattern (see `cleanSingleVideoUrl`), so it can carry
 * arbitrary non-whitespace text straight from a pass submission.
 *
 * Escaping `<` and `>` makes any closing sequence unreachable, and `&` is
 * escaped so the `\uXXXX` output cannot itself be spoofed. U+2028/U+2029 are
 * legal inside JSON strings but are line terminators to older JS parsers, so
 * they are escaped too.
 */
export function escapeJsonLd(json: string): string {
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Serialise a value into an escaped, inline-safe JSON-LD script body. */
export function serializeJsonLd(block: unknown): string {
  return escapeJsonLd(JSON.stringify(block));
}
