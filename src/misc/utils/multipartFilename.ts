import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Busboy (used by multer 1.4.5-lts.1) decodes Content-Disposition parameters as
 * latin-1 by default, and multer does not forward the `defParamCharset: 'utf8'`
 * option. Node's `form-data` library (and modern browsers) write filename bytes
 * as UTF-8, so non-ASCII names (e.g. Japanese, Cyrillic, accented Latin) come
 * out as classic mojibake — "かめりあ" → "ã__ã__ã__ã__".
 *
 * Because latin-1 is a 1:1 byte→codepoint mapping, we can recover the original
 * UTF-8 bytes by re-encoding the string as latin-1 and decoding as UTF-8.
 * Pure-ASCII names round-trip unchanged, so the fix is safe to apply
 * unconditionally to every multer-produced filename in this codebase.
 */

/**
 * Recover a UTF-8 filename that busboy mis-decoded as latin-1, and NFC-normalise
 * it so the value matches the chunked-upload init path (which already calls
 * `file.name.normalize('NFC')` in `ChunkedUploadClient`).
 *
 * Safe for already-correct strings: if the input is pure ASCII the round-trip
 * is a no-op, and if the decoded UTF-8 would be invalid we keep the input as-is.
 */
export function decodeMultipartFilename(raw: string | undefined | null): string {
  if (!raw) return '';
  // Fast path: pure ASCII round-trips through any latin-1 ⇄ utf-8 conversion.
  let hasHighByte = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0x7f) {
      hasHighByte = true;
      break;
    }
  }
  if (!hasHighByte) {
    return raw.normalize('NFC');
  }

  try {
    const bytes = Buffer.from(raw, 'latin1');
    // `fatal: true` rejects invalid UTF-8 so we don't clobber names that are
    // already correctly decoded (e.g. if a future multer upgrade starts
    // honouring defParamCharset).
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded.normalize('NFC');
  } catch {
    return raw.normalize('NFC');
  }
}

/** Mutate `req.file` / `req.files` so every `originalname` is valid UTF-8 NFC. */
export function fixMulterFileEncodings(req: Request): void {
  const single = (req as Request & { file?: Express.Multer.File }).file;
  if (single?.originalname) {
    single.originalname = decodeMultipartFilename(single.originalname);
  }

  const many = (req as Request & {
    files?: Express.Multer.File[] | Record<string, Express.Multer.File[]>;
  }).files;
  if (Array.isArray(many)) {
    for (const f of many) {
      if (f?.originalname) f.originalname = decodeMultipartFilename(f.originalname);
    }
  } else if (many && typeof many === 'object') {
    for (const key of Object.keys(many)) {
      const arr = many[key];
      if (Array.isArray(arr)) {
        for (const f of arr) {
          if (f?.originalname) f.originalname = decodeMultipartFilename(f.originalname);
        }
      }
    }
  }
}

/**
 * Wrap any multer middleware (`.single`, `.array`, `.fields`, `.any`, `.none`)
 * so the resulting `req.file` / `req.files` always expose UTF-8 NFC filenames,
 * regardless of busboy's latin-1 default.
 *
 * Usage: `cdnLocalTemp.upload` → `withUtf8Filenames(cdnLocalTemp.upload)`.
 */
export function withUtf8Filenames(middleware: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, (err?: unknown) => {
      if (!err) {
        try {
          fixMulterFileEncodings(req);
        } catch {
          // Never let the fixup crash the request — worst case the caller sees
          // the original (mojibake) name, which matches pre-fix behaviour.
        }
      }
      next(err as Parameters<NextFunction>[0]);
    });
  };
}
