import fs from 'fs';
import JSON5 from 'json5';

/** Skip surgical rewrite of pathological charts that would inflate ingest memory. */
export const MAX_LEVEL_PITCH_REWRITE_BYTES = 256 * 1024 * 1024;

export type PitchStripUnchanged = {status: 'unchanged'};
export type PitchStripSkipped = {status: 'skipped'; reason: string};
export type PitchStripChanged = {
    status: 'stripped';
    removedValue: unknown;
    text: string;
};

export type PitchStripResult = PitchStripUnchanged | PitchStripSkipped | PitchStripChanged;

export type FilePitchStripResult =
    | PitchStripUnchanged
    | PitchStripSkipped
    | {status: 'stripped'; removedValue: unknown};

function parseSettingsBlob(raw: string): Record<string, unknown> | null {
    try {
        const parsed = JSON5.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        /* ADOFAI editor output often needs comma repair */
    }
    try {
        const cleaned = raw
            .replace(/,(\s*[}\]])/g, '$1')
            .replace(/([}\]])[\s\n\t]*([{"\[])/g, '$1,$2')
            .replace(/([}\]])[\s\n\t]*("[\w]+":)/g, '$1,$2')
            .replace(/([}\]])[\s\n\t]*('[\w]+':)/g, '$1,$2');
        const parsed = JSON5.parse(cleaned);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * `100` (number) and `"100"` / `"100%"` (optional surrounding space) are original speed.
 */
export function isNeutralPitch(value: unknown): boolean {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value === 100;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        const withoutPercent = trimmed.endsWith('%') ? trimmed.slice(0, -1).trim() : trimmed;
        if (withoutPercent === '') {
            return false;
        }
        const n = Number(withoutPercent);
        return Number.isFinite(n) && n === 100;
    }
    return false;
}

function isWs(c: string | undefined): boolean {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

function isIdentStart(c: string): boolean {
    return /[A-Za-z_$]/.test(c);
}

function isIdentContinue(c: string): boolean {
    return /[A-Za-z0-9_$]/.test(c);
}

class Json5Cursor {
    readonly s: string;
    i: number;

    constructor(s: string, i = 0) {
        this.s = s;
        this.i = i;
    }

    peek(): string | undefined {
        return this.s[this.i];
    }

    skipWsAndComments(): void {
        const s = this.s;
        while (this.i < s.length) {
            const c = s[this.i];
            if (isWs(c)) {
                this.i++;
                continue;
            }
            if (c === '/' && s[this.i + 1] === '/') {
                this.i += 2;
                while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') {
                    this.i++;
                }
                continue;
            }
            if (c === '/' && s[this.i + 1] === '*') {
                this.i += 2;
                while (this.i < s.length) {
                    if (s[this.i] === '*' && s[this.i + 1] === '/') {
                        this.i += 2;
                        break;
                    }
                    this.i++;
                }
                continue;
            }
            return;
        }
    }

    skipString(): boolean {
        const quote = this.s[this.i];
        if (quote !== '"' && quote !== "'") {
            return false;
        }
        this.i++;
        while (this.i < this.s.length) {
            const c = this.s[this.i];
            if (c === '\\') {
                this.i += 2;
                continue;
            }
            if (c === quote) {
                this.i++;
                return true;
            }
            this.i++;
        }
        return false;
    }

    skipNumber(): void {
        const s = this.s;
        if (s[this.i] === '+' || s[this.i] === '-') {
            this.i++;
        }
        if (s[this.i] === '0' && (s[this.i + 1] === 'x' || s[this.i + 1] === 'X')) {
            this.i += 2;
            while (this.i < s.length && /[0-9a-fA-F]/.test(s[this.i]!)) {
                this.i++;
            }
            return;
        }
        while (this.i < s.length && /[0-9]/.test(s[this.i]!)) {
            this.i++;
        }
        if (s[this.i] === '.') {
            this.i++;
            while (this.i < s.length && /[0-9]/.test(s[this.i]!)) {
                this.i++;
            }
        }
        if (s[this.i] === 'e' || s[this.i] === 'E') {
            this.i++;
            if (s[this.i] === '+' || s[this.i] === '-') {
                this.i++;
            }
            while (this.i < s.length && /[0-9]/.test(s[this.i]!)) {
                this.i++;
            }
        }
    }

    skipIdent(): string {
        const start = this.i;
        if (this.i < this.s.length && isIdentStart(this.s[this.i]!)) {
            this.i++;
            while (this.i < this.s.length && isIdentContinue(this.s[this.i]!)) {
                this.i++;
            }
        }
        return this.s.slice(start, this.i);
    }

    skipValue(): boolean {
        this.skipWsAndComments();
        const c = this.peek();
        if (c === undefined) {
            return false;
        }
        if (c === '"' || c === "'") {
            return this.skipString();
        }
        if (c === '{') {
            return this.skipBalanced('{', '}');
        }
        if (c === '[') {
            return this.skipBalanced('[', ']');
        }
        if (c === '+' || c === '-' || c === '.' || /[0-9]/.test(c)) {
            this.skipNumber();
            return true;
        }
        if (isIdentStart(c)) {
            this.skipIdent();
            return true;
        }
        return false;
    }

    skipBalanced(open: '{' | '[', close: '}' | ']'): boolean {
        if (this.peek() !== open) {
            return false;
        }
        this.i++;
        let depth = 1;
        while (this.i < this.s.length && depth > 0) {
            const c = this.s[this.i];
            if (c === '"' || c === "'") {
                if (!this.skipString()) {
                    return false;
                }
                continue;
            }
            if (c === '/' && (this.s[this.i + 1] === '/' || this.s[this.i + 1] === '*')) {
                this.skipWsAndComments();
                continue;
            }
            if (c === open) {
                depth++;
            } else if (c === close) {
                depth--;
            }
            this.i++;
        }
        return depth === 0;
    }

    readKey(): string | null {
        this.skipWsAndComments();
        const c = this.peek();
        if (c === '"' || c === "'") {
            const start = this.i;
            if (!this.skipString()) {
                return null;
            }
            try {
                return JSON5.parse(this.s.slice(start, this.i)) as string;
            } catch {
                return this.s.slice(start + 1, this.i - 1);
            }
        }
        if (c && isIdentStart(c)) {
            return this.skipIdent();
        }
        return null;
    }
}

function skipBom(text: string): number {
    return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

/**
 * Span of the root `settings` object, including its `{` `}`.
 */
export function findRootSettingsSpan(text: string): {start: number; end: number} | null {
    const cur = new Json5Cursor(text, skipBom(text));
    cur.skipWsAndComments();
    if (cur.peek() !== '{') {
        return null;
    }
    cur.i++;
    while (cur.i < text.length) {
        cur.skipWsAndComments();
        if (cur.peek() === '}') {
            return null;
        }
        if (cur.peek() === ',') {
            cur.i++;
            continue;
        }
        const key = cur.readKey();
        if (key === null) {
            return null;
        }
        cur.skipWsAndComments();
        if (cur.peek() !== ':') {
            return null;
        }
        cur.i++;
        cur.skipWsAndComments();
        if (key === 'settings' && cur.peek() === '{') {
            const start = cur.i;
            if (!cur.skipBalanced('{', '}')) {
                return null;
            }
            return {start, end: cur.i};
        }
        if (!cur.skipValue()) {
            return null;
        }
        cur.skipWsAndComments();
        if (cur.peek() === ',') {
            cur.i++;
        }
    }
    return null;
}

type PropertySpan = {
    keyStart: number;
    valueEnd: number;
};

function findTopLevelPropertySpans(objectText: string, propertyName: string): PropertySpan[] {
    const cur = new Json5Cursor(objectText, 0);
    cur.skipWsAndComments();
    if (cur.peek() !== '{') {
        return [];
    }
    cur.i++;
    const spans: PropertySpan[] = [];
    while (cur.i < objectText.length) {
        cur.skipWsAndComments();
        if (cur.peek() === '}') {
            break;
        }
        if (cur.peek() === ',') {
            cur.i++;
            continue;
        }
        const keyStart = cur.i;
        const key = cur.readKey();
        if (key === null) {
            return [];
        }
        cur.skipWsAndComments();
        if (cur.peek() !== ':') {
            return [];
        }
        cur.i++;
        if (!cur.skipValue()) {
            return [];
        }
        const valueEnd = cur.i;
        if (key === propertyName) {
            spans.push({keyStart, valueEnd});
        }
        cur.skipWsAndComments();
        if (cur.peek() === ',') {
            cur.i++;
        }
    }
    return spans;
}

function expandRemovalSpan(objectText: string, span: PropertySpan): {start: number; end: number} {
    let after = span.valueEnd;
    while (isWs(objectText[after])) {
        after++;
    }
    if (objectText[after] === ',') {
        after++;
        while (isWs(objectText[after])) {
            after++;
        }
        return {start: span.keyStart, end: after};
    }

    let before = span.keyStart;
    while (before > 0 && isWs(objectText[before - 1])) {
        before--;
    }
    if (before > 0 && objectText[before - 1] === ',') {
        return {start: before - 1, end: span.valueEnd};
    }

    return {start: span.keyStart, end: span.valueEnd};
}

function removeTopLevelPitchProperties(objectText: string): string | null {
    const spans = findTopLevelPropertySpans(objectText, 'pitch');
    if (spans.length === 0) {
        return null;
    }
    const removals = spans.map((span) => expandRemovalSpan(objectText, span));
    removals.sort((a, b) => b.start - a.start);
    let next = objectText;
    for (const removal of removals) {
        next = next.slice(0, removal.start) + next.slice(removal.end);
    }
    return next;
}

/**
 * Delete `settings.pitch` when it is present and not 100%. Neutral and missing pitch are left
 * alone. The rest of the chart bytes are unchanged.
 */
export function stripNonDefaultPitchInLevelText(text: string): PitchStripResult {
    const span = findRootSettingsSpan(text);
    if (!span) {
        return {status: 'skipped', reason: 'root settings object not found'};
    }

    const settingsText = text.slice(span.start, span.end);
    const parsed = parseSettingsBlob(settingsText);
    if (!parsed) {
        return {status: 'skipped', reason: 'settings object could not be parsed'};
    }

    if (!Object.prototype.hasOwnProperty.call(parsed, 'pitch')) {
        return {status: 'unchanged'};
    }

    const removedValue = parsed.pitch;
    if (isNeutralPitch(removedValue)) {
        return {status: 'unchanged'};
    }

    const strippedSettings = removeTopLevelPitchProperties(settingsText);
    if (strippedSettings === null) {
        return {status: 'skipped', reason: 'settings.pitch could not be located in source text'};
    }

    return {
        status: 'stripped',
        removedValue,
        text: text.slice(0, span.start) + strippedSettings + text.slice(span.end)
    };
}

export function stripNonDefaultPitchFromSettingsRecord(
    settings: Record<string, unknown> | null | undefined
): {changed: boolean; removedValue?: unknown} {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return {changed: false};
    }
    if (!Object.prototype.hasOwnProperty.call(settings, 'pitch')) {
        return {changed: false};
    }
    const removedValue = settings.pitch;
    if (isNeutralPitch(removedValue)) {
        return {changed: false};
    }
    delete settings.pitch;
    return {changed: true, removedValue};
}

export async function stripNonDefaultPitchInLevelFile(filePath: string): Promise<FilePitchStripResult> {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_LEVEL_PITCH_REWRITE_BYTES) {
        return {
            status: 'skipped',
            reason: `file size ${stat.size} exceeds rewrite cap ${MAX_LEVEL_PITCH_REWRITE_BYTES}`
        };
    }
    const text = await fs.promises.readFile(filePath, 'utf8');
    const result = stripNonDefaultPitchInLevelText(text);
    if (result.status !== 'stripped') {
        return result;
    }
    await fs.promises.writeFile(filePath, result.text, 'utf8');
    return {status: 'stripped', removedValue: result.removedValue};
}
