export const FORMULA_FIELDS = [
  'speed', 'accuracy', 'score', 'keyCount', 'misses', 'perfects', 'earlies', 'lates',
  'ePerfect', 'lPerfect', 'family', 'familyAt', 'difficulty', 'difficultyAt', 'levelId',
  'songId', 'durationMs', 'worldsFirst', 'worldsFirstPP', 'purePerfect', 'ppMinusOne',
  'noMisses', 'symmetry', 'technicallyPure', 'noPerfects', 'asymmetry', 'ancient',
  'xPerfect', 'month', 'day',   'clears', 'reference', 'charterCount', 'vfxerCount', 'accuracyText', 'scoreText',
  'perfect', 'perfectMinus', 'perfectPlus', 'song',
] as const;

const FIELD_CANON = new Map(FORMULA_FIELDS.map((name) => [name.toLowerCase(), name]));
const FUNCTIONS = new Set(['AND', 'OR', 'NOT', 'IF', 'ISBLANK', 'EXACT', 'HAS', 'LEFT', 'RIGHT', 'LEN']);

export type FormulaValue = number | string | boolean | null;

export type FormulaContext = Record<string, FormulaValue | string[] | undefined>;

type Ast =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'field'; name: string }
  | { k: 'un'; op: 'neg'; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'call'; name: string; args: Ast[] };

export type FormulaParse = { ok: true; empty?: boolean } | { ok: false; error: string };

class FormulaError extends Error {}

class Parser {
  private readonly source: string;
  private index = 0;

  constructor(input: string) {
    const text = input.trim();
    this.source = text.startsWith('=') ? text.slice(1).trim() : text;
  }

  parse(): Ast {
    if (!this.source) throw new FormulaError('Enter a condition, or leave the formula empty');
    const ast = this.parseOr();
    this.skip();
    if (this.index < this.source.length) {
      throw new FormulaError(`Unexpected "${this.source.slice(this.index, this.index + 16)}"`);
    }
    this.check(ast);
    return ast;
  }

  private check(ast: Ast): void {
    if (ast.k === 'field' && !FIELD_CANON.has(ast.name.toLowerCase())) {
      throw new FormulaError(`Unknown field "${ast.name}"`);
    }
    if (ast.k === 'call' && !FUNCTIONS.has(ast.name)) {
      throw new FormulaError(`Unknown function ${ast.name}`);
    }
    if (ast.k === 'un') this.check(ast.a);
    if (ast.k === 'bin') {
      this.check(ast.a);
      this.check(ast.b);
    }
    if (ast.k === 'call') {
      if (ast.name === 'NOT' && ast.args.length !== 1) throw new FormulaError('NOT expects 1 argument');
      if (ast.name === 'IF' && ast.args.length !== 3) throw new FormulaError('IF expects condition, value if true, value if false');
      if (ast.name === 'ISBLANK' && ast.args.length !== 1) throw new FormulaError('ISBLANK expects 1 argument');
      if ((ast.name === 'AND' || ast.name === 'OR') && ast.args.length < 2) {
        throw new FormulaError(`${ast.name} expects at least 2 arguments`);
      }
      if (ast.name === 'EXACT' && ast.args.length !== 2) throw new FormulaError('EXACT expects 2 arguments');
      if (ast.name === 'HAS' && ast.args.length !== 1) throw new FormulaError('HAS expects a curation name');
      if ((ast.name === 'LEFT' || ast.name === 'RIGHT') && ast.args.length !== 2) {
        throw new FormulaError(`${ast.name} expects text and a count`);
      }
      if (ast.name === 'LEN' && ast.args.length !== 1) throw new FormulaError('LEN expects text');
      for (const arg of ast.args) this.check(arg);
    }
  }

  private skip(): void {
    while (this.source[this.index] === ' ' || this.source[this.index] === '\n' || this.source[this.index] === '\t') {
      this.index += 1;
    }
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.word('OR')) left = { k: 'call', name: 'OR', args: [left, this.parseAnd()] };
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseCmp();
    while (this.word('AND')) left = { k: 'call', name: 'AND', args: [left, this.parseCmp()] };
    return left;
  }

  private parseCmp(): Ast {
    let left = this.parseAdd();
    const op = this.operator();
    if (!op) return left;
    return { k: 'bin', op, a: left, b: this.parseAdd() };
  }

  private parseAdd(): Ast {
    let left = this.parseMul();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.source[this.index];
      this.index += 1;
      left = { k: 'bin', op, a: left, b: this.parseMul() };
    }
    return left;
  }

  private parseMul(): Ast {
    let left = this.parseUnary();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.source[this.index];
      this.index += 1;
      left = { k: 'bin', op, a: left, b: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Ast {
    if (this.word('NOT')) return { k: 'call', name: 'NOT', args: [this.parseUnary()] };
    if (this.peek() === '-') {
      this.index += 1;
      return { k: 'un', op: 'neg', a: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Ast {
    this.skip();
    const ch = this.source[this.index];
    if (ch === '(') {
      this.index += 1;
      const inner = this.parseOr();
      this.skip();
      if (this.source[this.index] !== ')') throw new FormulaError('Missing )');
      this.index += 1;
      return inner;
    }
    if (ch === '"') return { k: 'str', v: this.string() };
    if (ch === '.' || (ch >= '0' && ch <= '9')) return { k: 'num', v: this.number() };
    const ident = this.ident();
    if (!ident) throw new FormulaError('Expected a value');
    const upper = ident.toUpperCase();
    if (upper === 'TRUE') return { k: 'bool', v: true };
    if (upper === 'FALSE') return { k: 'bool', v: false };
    this.skip();
    if (this.source[this.index] === '(') {
      this.index += 1;
      const args: Ast[] = [];
      this.skip();
      if (this.source[this.index] !== ')') {
        args.push(this.parseOr());
        while (this.separator()) args.push(this.parseOr());
      }
      this.skip();
      if (this.source[this.index] !== ')') throw new FormulaError(`Missing ) after ${upper}`);
      this.index += 1;
      return { k: 'call', name: upper, args };
    }
    const canon = FIELD_CANON.get(ident.toLowerCase());
    if (!canon) throw new FormulaError(`Unknown field "${ident}"`);
    return { k: 'field', name: canon };
  }

  private separator(): boolean {
    this.skip();
    if (this.source[this.index] !== ',' && this.source[this.index] !== ';') return false;
    this.index += 1;
    return true;
  }

  private word(name: string): boolean {
    this.skip();
    const slice = this.source.slice(this.index, this.index + name.length);
    if (slice.toUpperCase() !== name) return false;
    const after = this.source[this.index + name.length];
    if (after && /[A-Za-z0-9_]/.test(after)) return false;
    this.index += name.length;
    return true;
  }

  private operator(): string | null {
    this.skip();
    const two = this.source.slice(this.index, this.index + 2);
    if (two === '<>' || two === '>=' || two === '<=') {
      this.index += 2;
      return two;
    }
    const one = this.source[this.index];
    if (one === '=' || one === '>' || one === '<') {
      this.index += 1;
      return one;
    }
    return null;
  }

  private string(): string {
    this.index += 1;
    let out = '';
    while (this.index < this.source.length) {
      const ch = this.source[this.index];
      if (ch === '"') {
        if (this.source[this.index + 1] === '"') {
          out += '"';
          this.index += 2;
          continue;
        }
        this.index += 1;
        return out;
      }
      out += ch;
      this.index += 1;
    }
    throw new FormulaError('Missing closing quote');
  }

  private number(): number {
    const start = this.index;
    while (/[0-9.]/.test(this.source[this.index] || '')) this.index += 1;
    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value)) throw new FormulaError('Invalid number');
    return value;
  }

  private ident(): string {
    this.skip();
    const start = this.index;
    if (!/[A-Za-z_]/.test(this.source[this.index] || '')) return '';
    this.index += 1;
    while (/[A-Za-z0-9_]/.test(this.source[this.index] || '')) this.index += 1;
    return this.source.slice(start, this.index);
  }

  private peek(): string {
    this.skip();
    return this.source[this.index] || '';
  }
}

function truthy(value: FormulaValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return false;
}

function asNumber(value: FormulaValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null || value === '') return NaN;
  return Number(value);
}

function compare(op: string, left: FormulaValue, right: FormulaValue): boolean {
  const bothNumeric = typeof left === 'number' && typeof right === 'number';
  if (bothNumeric || (typeof left === 'boolean' && typeof right === 'boolean')) {
    const a = asNumber(left);
    const b = asNumber(right);
    if (op === '=') return a === b;
    if (op === '<>') return a !== b;
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
  }
  const a = left == null ? '' : String(left).toLowerCase();
  const b = right == null ? '' : String(right).toLowerCase();
  if (op === '=') return a === b;
  if (op === '<>') return a !== b;
  if (op === '>') return a > b;
  if (op === '>=') return a >= b;
  if (op === '<') return a < b;
  return a <= b;
}

function evaluate(ast: Ast, ctx: FormulaContext): FormulaValue {
  if (ast.k === 'num') return ast.v;
  if (ast.k === 'str') return ast.v;
  if (ast.k === 'bool') return ast.v;
  if (ast.k === 'field') {
    const value = ctx[ast.name] ?? ctx[ast.name.toLowerCase()];
    if (value == null || Array.isArray(value)) return null;
    return value;
  }
  if (ast.k === 'un') {
    const value = asNumber(evaluate(ast.a, ctx));
    return Number.isFinite(value) ? -value : null;
  }
  if (ast.k === 'bin') {
    const left = evaluate(ast.a, ctx);
    const right = evaluate(ast.b, ctx);
    if (ast.op === '+' || ast.op === '-' || ast.op === '*' || ast.op === '/') {
      const a = asNumber(left);
      const b = asNumber(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      if (ast.op === '+') return a + b;
      if (ast.op === '-') return a - b;
      if (ast.op === '*') return a * b;
      return b === 0 ? null : a / b;
    }
    return compare(ast.op, left, right);
  }
  return evalCall(ast.name, ast.args, ctx);
}

function evalCall(name: string, args: Ast[], ctx: FormulaContext): FormulaValue {
  if (name === 'AND') return args.every((arg) => truthy(evaluate(arg, ctx)));
  if (name === 'OR') return args.some((arg) => truthy(evaluate(arg, ctx)));
  if (name === 'NOT') return !truthy(evaluate(args[0], ctx));
  if (name === 'IF') return truthy(evaluate(args[0], ctx)) ? evaluate(args[1], ctx) : evaluate(args[2], ctx);
  if (name === 'ISBLANK') {
    const value = evaluate(args[0], ctx);
    return value == null || value === '';
  }
  if (name === 'EXACT') {
    return String(evaluate(args[0], ctx) ?? '') === String(evaluate(args[1], ctx) ?? '');
  }
  if (name === 'LEN') return String(evaluate(args[0], ctx) ?? '').length;
  if (name === 'LEFT' || name === 'RIGHT') {
    const text = String(evaluate(args[0], ctx) ?? '');
    const count = asNumber(evaluate(args[1], ctx));
    if (!Number.isFinite(count) || count <= 0) return '';
    return name === 'LEFT' ? text.slice(0, count) : text.slice(-count);
  }
  const wanted = String(evaluate(args[0], ctx) ?? '').toLowerCase();
  const curation = ctx.curation;
  const names = Array.isArray(curation) ? curation : [];
  return names.some((name) => name.toLowerCase() === wanted);
}

export function parseFormula(input: string | null | undefined): FormulaParse {
  const text = String(input ?? '').trim();
  if (!text || text === '=') return { ok: true, empty: true };
  try {
    new Parser(text).parse();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid formula' };
  }
}

export function formulaMatches(input: string | null | undefined, ctx: FormulaContext): boolean {
  const text = String(input ?? '').trim();
  if (!text || text === '=') return true;
  try {
    return truthy(evaluate(new Parser(text).parse(), ctx));
  } catch {
    return false;
  }
}
