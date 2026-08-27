import JSON5 from 'json5';

export type OversizedLevelBasics = {
  tilecount: number;
  settings: {
    bpm?: unknown;
    offset?: unknown;
    songFilename?: unknown;
    /** Title field. Read for ZIP-filename encoding detection (used as a fallback reference string). */
    song?: unknown;
    /** Artist field. Read for ZIP-filename encoding detection. */
    artist?: unknown;
    /** Author field. Read for ZIP-filename encoding detection. */
    author?: unknown;
  };
};

/** Settings keys we extract for both the oversized-cache path and ZIP-filename encoding detection. */
export const SETTINGS_KEYS_OF_INTEREST = [
  'bpm',
  'offset',
  'songFilename',
  'song',
  'artist',
  'author',
] as const;

type Phase =
  | 'seekRoot'
  | 'rootKey'
  | 'rootColon'
  | 'rootValue'
  | 'afterValue'
  | 'angleItems'
  | 'pathString'
  | 'settings'
  | 'skip';

const SIMPLE_ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
};

function isWs(c: string): boolean {
  return c.trim() === '' || c === '\uFEFF';
}

function isIdentStart(c: string): boolean {
  return c === '_' || c === '$' || /[A-Za-z]/.test(c);
}

function isIdentContinue(c: string): boolean {
  return isIdentStart(c) || /[0-9]/.test(c);
}

function isNumberStart(c: string): boolean {
  return c === '+' || c === '-' || c === '.' || /[0-9]/.test(c);
}

function isNumberContinue(token: string, c: string): boolean {
  if (/[0-9]/.test(c)) return true;
  if ((c === 'x' || c === 'X') && /^[+-]?0$/.test(token)) return true;
  if (/[0-9a-fA-F]/.test(c) && /0x/i.test(token)) return true;
  if (c === '.' && !token.includes('.') && !/[eExX]/.test(token)) return true;
  if ((c === 'e' || c === 'E') && !/[eE]/.test(token.replace(/0x[\da-fA-F]*/i, ''))) {
    return true;
  }
  if ((c === '+' || c === '-') && /[eE]$/.test(token)) return true;
  return false;
}

function pickSettingsFromObject(parsed: unknown, settings: OversizedLevelBasics['settings']): void {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const rec = parsed as Record<string, unknown>;
  for (const key of SETTINGS_KEYS_OF_INTEREST) {
    if (rec[key] !== undefined) {
      settings[key] = rec[key];
    }
  }
}

function parseSettingsBlob(raw: string): unknown | null {
  try {
    return JSON5.parse(raw);
  } catch {
    /* try comma repairs used for ADOFAI editor output */
  }
  try {
    const cleaned = raw
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([}\]])[\s\n\t]*([{"\[])/g, '$1,$2')
      .replace(/([}\]])[\s\n\t]*("[\w]+":)/g, '$1,$2')
      .replace(/([}\]])[\s\n\t]*('[\w]+':)/g, '$1,$2');
    return JSON5.parse(cleaned);
  } catch {
    return null;
  }
}

function extractSettingsLoose(raw: string, settings: OversizedLevelBasics['settings']): void {
  for (const key of ['songFilename', 'song', 'artist', 'author'] as const) {
    if (settings[key] !== undefined) continue;
    const re = new RegExp(`['"]${key}['"]\\s*:\\s*['"]((?:[^'"\\\\]|\\\\.)*)['"]`);
    const m = re.exec(raw);
    if (!m) continue;
    try {
      const parsed = JSON5.parse(`"${m[1]}"`);
      if (typeof parsed === 'string') settings[key] = parsed;
    } catch {
      settings[key] = m[1];
    }
  }
  for (const key of ['bpm', 'offset'] as const) {
    if (settings[key] !== undefined) continue;
    const re = new RegExp(`['"]${key}['"]\\s*:\\s*([+\\-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`);
    const m = re.exec(raw);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) settings[key] = n;
  }
}

/**
 * Streaming JSON5 walker for oversized `.adofai` files.
 *
 * Counts finite numbers in top-level `angleData` (or `pathData` length) and reads
 * `settings` without materializing the rest of the document. Stops as soon as both
 * a tile source and `settings` are complete so later illegal JSON (control chars in
 * comments, huge decorations, trailing garbage) is never parsed.
 */
export class Json5LevelScanner {
  tilecount = 0;
  settings: OversizedLevelBasics['settings'] = {};
  done = false;
  seenAngleData = false;
  seenPathData = false;
  seenSettings = false;

  private hold = '';
  private phase: Phase = 'seekRoot';
  private currentRootKey = '';

  private inLineComment = false;
  private inBlockComment = false;
  private blockStar = false;
  private inString = false;
  private stringQuote: '"' | "'" = '"';
  private escaped = false;
  private unicodeLeft = 0;
  private unicodeBuf = '';
  private inNumber = false;
  private inIdent = false;
  private token = '';
  private stringBuf = '';
  private pathLen = 0;

  private skipDepth = 0;
  private skipAfterPrimitive: Phase = 'afterValue';
  private angleNested = 0;

  private settingsBuf = '';
  private settingsDepth = 0;

  result(): OversizedLevelBasics {
    return {tilecount: this.tilecount, settings: this.settings};
  }

  feed(chunk: string, eof: boolean): void {
    if (this.done) return;
    const input = this.hold + chunk;
    this.hold = '';
    let i = 0;
    while (i < input.length && !this.done) {
      const consumed = this.step(input, i, eof);
      if (consumed < 0) {
        this.hold = input.slice(i);
        return;
      }
      if (consumed === 0) {
        continue;
      }
      i += consumed;
    }
    if (eof && !this.done) {
      this.flushEof();
    }
  }

  private step(s: string, i: number, eof: boolean): number {
    const c = s[i];
    const next = i + 1 < s.length ? s[i + 1] : eof ? '' : undefined;

    if (this.inLineComment) {
      if (this.phase === 'settings') this.settingsBuf += c;
      if (c === '\n' || c === '\r') this.inLineComment = false;
      return 1;
    }
    if (this.inBlockComment) {
      if (this.phase === 'settings') this.settingsBuf += c;
      if (this.blockStar && c === '/') {
        this.inBlockComment = false;
        this.blockStar = false;
      } else {
        this.blockStar = c === '*';
      }
      return 1;
    }
    if (this.inString) {
      return this.stepString(c, next);
    }
    if (this.inNumber) {
      return this.stepNumber(c);
    }
    if (this.inIdent) {
      return this.stepIdent(c);
    }

    if (c === '/') {
      if (next === undefined) return -1;
      if (next === '/' || next === '*') {
        if (this.phase === 'settings') this.settingsBuf += c + next;
        this.inLineComment = next === '/';
        this.inBlockComment = next === '*';
        this.blockStar = false;
        return 2;
      }
    }

    if (this.phase === 'settings') {
      return this.stepSettings(c);
    }

    if (isWs(c)) return 1;

    switch (this.phase) {
      case 'seekRoot':
        if (c === '{') {
          this.phase = 'rootKey';
        }
        return 1;
      case 'rootKey':
        return this.stepRootKey(c);
      case 'rootColon':
        if (c === ':') {
          this.phase = 'rootValue';
        }
        return 1;
      case 'rootValue':
        return this.stepRootValue(c);
      case 'afterValue':
        return this.stepAfterValue(c);
      case 'angleItems':
        return this.stepAngleItems(c);
      case 'skip':
        return this.stepSkip(c);
      case 'pathString':
        return 1;
      default:
        return 1;
    }
  }

  private stepString(c: string, next: string | undefined): number {
    if (this.phase === 'settings') this.settingsBuf += c;

    if (this.unicodeLeft > 0) {
      this.unicodeBuf += c;
      this.unicodeLeft--;
      if (this.unicodeLeft === 0) {
        const code = Number.parseInt(this.unicodeBuf, 16);
        const ch = Number.isFinite(code) ? String.fromCharCode(code) : '';
        this.emitStringChar(ch);
        this.unicodeBuf = '';
      }
      return 1;
    }

    if (this.escaped) {
      this.escaped = false;
      if (c === 'u') {
        this.unicodeLeft = 4;
        this.unicodeBuf = '';
        return 1;
      }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') {
          if (this.phase === 'settings') {
            /* next LF is appended in the following step */
          }
          return 1;
        }
        return 1;
      }
      this.emitStringChar(SIMPLE_ESCAPES[c] ?? c);
      return 1;
    }

    if (c === '\\') {
      this.escaped = true;
      return 1;
    }

    if (c === this.stringQuote) {
      this.inString = false;
      this.finishString();
      return 1;
    }

    this.emitStringChar(c);
    return 1;
  }

  private emitStringChar(ch: string): void {
    if (this.phase === 'pathString') {
      this.pathLen += ch.length;
      return;
    }
    if (this.phase === 'rootKey' || this.skipAfterPrimitive === 'rootColon') {
      this.stringBuf += ch;
    }
  }

  private finishString(): void {
    if (this.phase === 'rootKey') {
      this.currentRootKey = this.stringBuf;
      this.stringBuf = '';
      this.phase = 'rootColon';
      return;
    }
    if (this.phase === 'pathString') {
      if (!this.seenAngleData) {
        this.tilecount = this.pathLen;
      }
      this.seenPathData = true;
      this.phase = 'afterValue';
      this.maybeComplete();
      return;
    }
    if (this.phase === 'skip' && this.skipDepth === 0) {
      this.phase = this.skipAfterPrimitive;
      this.maybeCompleteAfterSkip();
    }
  }

  private stepNumber(c: string): number {
    if (isNumberContinue(this.token, c)) {
      this.token += c;
      return 1;
    }
    this.finishNumber();
    return 0;
  }

  private finishNumber(): void {
    const token = this.token;
    this.inNumber = false;
    this.token = '';
    const n = Number(token);
    if (this.phase === 'angleItems' && this.angleNested === 0 && Number.isFinite(n)) {
      this.tilecount++;
    }
    if (this.phase === 'skip' && this.skipDepth === 0) {
      this.phase = this.skipAfterPrimitive;
      this.maybeCompleteAfterSkip();
    }
  }

  private stepIdent(c: string): number {
    if (isIdentContinue(c)) {
      this.token += c;
      return 1;
    }
    this.finishIdent();
    return 0;
  }

  private finishIdent(): void {
    const token = this.token;
    this.inIdent = false;
    this.token = '';
    if (this.phase === 'rootKey') {
      this.currentRootKey = token;
      this.phase = 'rootColon';
      return;
    }
    if (this.phase === 'skip' && this.skipDepth === 0) {
      this.phase = this.skipAfterPrimitive;
      this.maybeCompleteAfterSkip();
    }
  }

  private stepRootKey(c: string): number {
    if (c === '}') {
      this.markDone();
      return 1;
    }
    if (c === '"' || c === "'") {
      this.inString = true;
      this.stringQuote = c;
      this.stringBuf = '';
      this.escaped = false;
      return 1;
    }
    if (isIdentStart(c)) {
      this.inIdent = true;
      this.token = c;
      return 1;
    }
    return 1;
  }

  private stepRootValue(c: string): number {
    const key = this.currentRootKey;
    if (key === 'angleData' && c === '[') {
      this.phase = 'angleItems';
      this.angleNested = 0;
      this.tilecount = 0;
      return 1;
    }
    if (key === 'pathData' && (c === '"' || c === "'")) {
      this.phase = 'pathString';
      this.inString = true;
      this.stringQuote = c;
      this.pathLen = 0;
      this.escaped = false;
      return 1;
    }
    if (key === 'settings' && c === '{') {
      this.phase = 'settings';
      this.settingsBuf = '{';
      this.settingsDepth = 1;
      return 1;
    }
    this.skipAfterPrimitive = 'afterValue';
    this.phase = 'skip';
    this.skipDepth = 0;
    if (key === 'angleData') this.seenAngleData = true;
    if (key === 'pathData') this.seenPathData = true;
    if (key === 'settings') this.seenSettings = true;
    return this.stepSkip(c);
  }

  private stepAfterValue(c: string): number {
    if (this.hasTileSource() && this.seenSettings) {
      this.markDone();
      return 0;
    }
    if (c === ',') {
      this.phase = 'rootKey';
      return 1;
    }
    if (c === '}') {
      this.markDone();
      return 1;
    }
    this.phase = 'rootKey';
    return this.stepRootKey(c);
  }

  private stepAngleItems(c: string): number {
    if (this.angleNested > 0) {
      return this.stepSkip(c);
    }
    if (c === ']') {
      this.seenAngleData = true;
      this.phase = 'afterValue';
      this.maybeComplete();
      return 1;
    }
    if (c === ',') return 1;
    if (c === '"' || c === "'") {
      this.inString = true;
      this.stringQuote = c;
      this.escaped = false;
      this.phase = 'skip';
      this.skipDepth = 0;
      this.skipAfterPrimitive = 'angleItems';
      return 1;
    }
    if (c === '{' || c === '[') {
      this.phase = 'skip';
      this.skipDepth = 1;
      this.skipAfterPrimitive = 'angleItems';
      this.angleNested = 1;
      return 1;
    }
    if (isNumberStart(c)) {
      this.inNumber = true;
      this.token = c;
      return 1;
    }
    if (isIdentStart(c)) {
      this.inIdent = true;
      this.token = c;
      this.phase = 'skip';
      this.skipDepth = 0;
      this.skipAfterPrimitive = 'angleItems';
      return 1;
    }
    return 1;
  }

  private stepSkip(c: string): number {
    if (c === '"' || c === "'") {
      this.inString = true;
      this.stringQuote = c;
      this.escaped = false;
      return 1;
    }
    if (c === '{' || c === '[') {
      this.skipDepth++;
      if (this.skipAfterPrimitive === 'angleItems') this.angleNested++;
      return 1;
    }
    if (c === '}' || c === ']') {
      if (this.skipDepth > 0) this.skipDepth--;
      if (this.skipAfterPrimitive === 'angleItems' && this.angleNested > 0) {
        this.angleNested--;
      }
      if (this.skipDepth === 0) {
        this.phase = this.skipAfterPrimitive;
        this.maybeCompleteAfterSkip();
      }
      return 1;
    }
    if (this.skipDepth === 0 && isNumberStart(c)) {
      this.inNumber = true;
      this.token = c;
      return 1;
    }
    if (this.skipDepth === 0 && isIdentStart(c)) {
      this.inIdent = true;
      this.token = c;
      return 1;
    }
    return 1;
  }

  private stepSettings(c: string): number {
    this.settingsBuf += c;
    if (c === '"' || c === "'") {
      this.inString = true;
      this.stringQuote = c;
      this.escaped = false;
      return 1;
    }
    if (c === '{') {
      this.settingsDepth++;
      return 1;
    }
    if (c === '}') {
      this.settingsDepth--;
      if (this.settingsDepth === 0) {
        this.finishSettings();
      }
      return 1;
    }
    return 1;
  }

  private finishSettings(): void {
    const parsed = parseSettingsBlob(this.settingsBuf);
    if (parsed) {
      pickSettingsFromObject(parsed, this.settings);
    } else {
      extractSettingsLoose(this.settingsBuf, this.settings);
    }
    this.settingsBuf = '';
    this.seenSettings = true;
    this.phase = 'afterValue';
    this.maybeComplete();
  }

  private maybeCompleteAfterSkip(): void {
    if (this.skipAfterPrimitive !== 'afterValue') return;
    const key = this.currentRootKey;
    if (key === 'angleData') this.seenAngleData = true;
    if (key === 'pathData') this.seenPathData = true;
    if (key === 'settings') this.seenSettings = true;
    this.maybeComplete();
  }

  private hasTileSource(): boolean {
    return this.seenAngleData || this.seenPathData;
  }

  private maybeComplete(): void {
    if (this.hasTileSource() && this.seenSettings) {
      this.markDone();
    }
  }

  private markDone(): void {
    this.done = true;
    this.phase = 'afterValue';
  }

  private flushEof(): void {
    if (this.inNumber) this.finishNumber();
    if (this.inIdent) this.finishIdent();
    if (this.phase === 'settings' && this.settingsBuf) {
      this.finishSettings();
    }
    this.done = true;
  }
}

/** Scan a complete `.adofai` document (or a prefix that already contains angleData + settings). */
export function scanJson5LevelText(text: string, chunkSize = 0): OversizedLevelBasics {
  const scanner = new Json5LevelScanner();
  if (chunkSize > 0) {
    for (let i = 0; i < text.length && !scanner.done; i += chunkSize) {
      const end = Math.min(text.length, i + chunkSize);
      scanner.feed(text.slice(i, end), end >= text.length);
    }
  } else {
    scanner.feed(text, true);
  }
  return scanner.result();
}
