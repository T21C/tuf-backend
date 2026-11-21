/**
 * A JavaScript-shaped expression that returns a number from clears and charts.
 * It is parsed and interpreted. It does not execute arbitrary JavaScript.
 */

import { throwIfBadgeCancelled } from '../jobs/cancelSignal.js';

export type Value =
  | number
  | string
  | boolean
  | null
  | Value[]
  | { kind: 'row'; fields: Record<string, Value> }
  | { kind: 'fn'; call: (args: Value[]) => Value };

type Ast =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'name'; name: string }
  | { k: 'array'; items: Ast[] }
  | { k: 'arrow'; params: string[]; body: Ast }
  | { k: 'un'; op: '!' | '-'; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'and'; a: Ast; b: Ast }
  | { k: 'or'; a: Ast; b: Ast }
  | { k: 'if'; c: Ast; a: Ast; b: Ast }
  | { k: 'member'; a: Ast; name: string; optional: boolean }
  | { k: 'index'; a: Ast; key: Ast; optional: boolean }
  | { k: 'call'; callee: Ast; args: Ast[] }
  | { k: 'method'; a: Ast; name: string; args: Ast[]; optional: boolean };

const BANNED = new Set([
  'constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
]);

export class ValueError extends Error {}

export function row(fields: Record<string, Value | undefined>): Value {
  const clean: Record<string, Value> = Object.create(null);
  for (const [key, value] of Object.entries(fields)) {
    if (BANNED.has(key)) continue;
    if (value !== undefined) clean[key] = value;
  }
  return { kind: 'row', fields: clean };
}

export function fn(call: (args: Value[]) => Value): Value {
  return { kind: 'fn', call };
}

const parsedExprCache = new Map<string, { ok: true; ast: Ast } | { ok: false; error: string }>();

export function parseValueExpr(input: string | null | undefined): { ok: true; ast: Ast } | { ok: false; error: string } {
  const text = String(input ?? '').trim().replace(/^=\s*/, '').trim();
  if (!text) return { ok: false, error: 'Enter an expression' };
  const cached = parsedExprCache.get(text);
  if (cached) return cached;
  let parsed: { ok: true; ast: Ast } | { ok: false; error: string };
  try {
    parsed = { ok: true, ast: new Parser(text).parse() };
  } catch (error) {
    parsed = { ok: false, error: error instanceof Error ? error.message : 'Invalid expression' };
  }
  parsedExprCache.set(text, parsed);
  return parsed;
}

export function valueExprNames(ast: Ast): Set<string> {
  const names = new Set<string>();
  collectNames(ast, names, new Set());
  return names;
}

function collectNames(ast: Ast, names: Set<string>, bound: Set<string>): void {
  switch (ast.k) {
    case 'name':
      if (!bound.has(ast.name)) names.add(ast.name);
      return;
    case 'array':
      for (const item of ast.items) collectNames(item, names, bound);
      return;
    case 'arrow': {
      const next = new Set(bound);
      for (const param of ast.params) next.add(param);
      collectNames(ast.body, names, next);
      return;
    }
    case 'un':
      collectNames(ast.a, names, bound);
      return;
    case 'bin':
    case 'and':
    case 'or':
      collectNames(ast.a, names, bound);
      collectNames(ast.b, names, bound);
      return;
    case 'if':
      collectNames(ast.c, names, bound);
      collectNames(ast.a, names, bound);
      collectNames(ast.b, names, bound);
      return;
    case 'member':
      collectNames(ast.a, names, bound);
      return;
    case 'index':
      collectNames(ast.a, names, bound);
      collectNames(ast.key, names, bound);
      return;
    case 'call':
      collectNames(ast.callee, names, bound);
      for (const arg of ast.args) collectNames(arg, names, bound);
      return;
    case 'method':
      collectNames(ast.a, names, bound);
      for (const arg of ast.args) collectNames(arg, names, bound);
      return;
    default:
      return;
  }
}

export function evalValueExpr(ast: Ast, bindings: Map<string, Value>): Value {
  return evaluate(ast, { bindings, parent: null });
}

export function valueAsNumber(value: Value): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === true) return 1;
  if (value === false || value == null) return 0;
  return null;
}

type Scope = { bindings: Map<string, Value>; parent: Scope | null };

class Parser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): Ast {
    const ast = this.parseExpr();
    this.skip();
    if (this.index < this.source.length) {
      throw new ValueError(`Unexpected "${this.source.slice(this.index, this.index + 16)}"`);
    }
    return ast;
  }

  private parseExpr(): Ast {
    return this.parseTernary();
  }

  private parseTernary(): Ast {
    const test = this.parseOr();
    this.skip();
    if (this.source[this.index] !== '?') return test;
    this.index += 1;
    const yes = this.parseExpr();
    this.skip();
    if (this.source[this.index] !== ':') throw new ValueError('Expected : in a condition');
    this.index += 1;
    return { k: 'if', c: test, a: yes, b: this.parseExpr() };
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.operator('||')) left = { k: 'or', a: left, b: this.parseAnd() };
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseEq();
    while (this.operator('&&')) left = { k: 'and', a: left, b: this.parseEq() };
    return left;
  }

  private parseEq(): Ast {
    let left = this.parseRel();
    for (;;) {
      const op = this.eqOp();
      if (!op) return left;
      left = { k: 'bin', op, a: left, b: this.parseRel() };
    }
  }

  private parseRel(): Ast {
    let left = this.parseAdd();
    for (;;) {
      const op = this.relOp();
      if (!op) return left;
      left = { k: 'bin', op, a: left, b: this.parseAdd() };
    }
  }

  private parseAdd(): Ast {
    let left = this.parseMul();
    for (;;) {
      this.skip();
      const op = this.source[this.index];
      if (op !== '+' && op !== '-') break;
      this.index += 1;
      left = { k: 'bin', op, a: left, b: this.parseMul() };
    }
    return left;
  }

  private parseMul(): Ast {
    let left = this.parseUnary();
    for (;;) {
      this.skip();
      const ch = this.source[this.index];
      if ((ch === '*' || ch === '/' || ch === '%') && this.source[this.index + 1] !== '/' && this.source[this.index + 1] !== '*') {
        this.index += 1;
        left = { k: 'bin', op: ch, a: left, b: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): Ast {
    this.skip();
    if (this.source[this.index] === '!') {
      this.index += 1;
      return { k: 'un', op: '!', a: this.parseUnary() };
    }
    if (this.source[this.index] === '-' && !this.isIdentChar(this.source[this.index - 1])) {
      this.index += 1;
      return { k: 'un', op: '-', a: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Ast {
    let expr = this.parsePrimary();
    for (;;) {
      this.skip();
      const optional = this.source[this.index] === '?' && this.source[this.index + 1] === '.';
      if (this.source[this.index] === '.' || optional) {
        this.index += optional ? 2 : 1;
        const name = this.ident();
        if (!name) throw new ValueError('Expected a property name');
        if (BANNED.has(name)) throw new ValueError(`Property ${name} is not available`);
        this.skip();
        if (this.source[this.index] === '(') {
          expr = { k: 'method', a: expr, name, args: this.args(), optional };
        } else {
          expr = { k: 'member', a: expr, name, optional };
        }
        continue;
      }
      if (this.source[this.index] === '(' && expr.k === 'name') {
        expr = { k: 'call', callee: expr, args: this.args() };
        continue;
      }
      if (this.source[this.index] === '[') {
        const mark = this.index;
        this.index += 1;
        const key = this.parseExpr();
        this.skip();
        if (this.source[this.index] !== ']') {
          this.index = mark;
          return expr;
        }
        this.index += 1;
        expr = { k: 'index', a: expr, key, optional: false };
        continue;
      }
      return expr;
    }
  }

  private parsePrimary(): Ast {
    this.skip();
    const arrow = this.tryArrow();
    if (arrow) return arrow;
    const ch = this.source[this.index];
    if (ch === '(') {
      this.index += 1;
      const inner = this.parseExpr();
      this.skip();
      if (this.source[this.index] !== ')') throw new ValueError('Missing )');
      this.index += 1;
      return inner;
    }
    if (ch === '[') return { k: 'array', items: this.args() };
    if (ch === '"' || ch === '\'') return { k: 'str', v: this.string(ch) };
    if (ch === '.' || (ch >= '0' && ch <= '9')) return { k: 'num', v: this.number() };
    const name = this.ident();
    if (!name) throw new ValueError('Expected a value');
    if (name === 'true') return { k: 'bool', v: true };
    if (name === 'false') return { k: 'bool', v: false };
    if (name === 'null') return { k: 'null' };
    this.skip();
    if (this.source.startsWith('=>', this.index)) {
      this.index += 2;
      return { k: 'arrow', params: [name], body: this.arrowBody() };
    }
    return { k: 'name', name };
  }

  private tryArrow(): Ast | null {
    const mark = this.index;
    this.skip();
    if (this.source[this.index] !== '(') {
      this.index = mark;
      return null;
    }
    this.index += 1;
    const params: string[] = [];
    this.skip();
    if (this.source[this.index] !== ')') {
      for (;;) {
        const name = this.ident();
        if (!name) {
          this.index = mark;
          return null;
        }
        params.push(name);
        this.skip();
        if (this.source[this.index] === ',') {
          this.index += 1;
          this.skip();
          continue;
        }
        break;
      }
    }
    this.skip();
    if (this.source[this.index] !== ')') {
      this.index = mark;
      return null;
    }
    this.index += 1;
    this.skip();
    if (!this.source.startsWith('=>', this.index)) {
      this.index = mark;
      return null;
    }
    this.index += 2;
    return { k: 'arrow', params, body: this.arrowBody() };
  }

  private arrowBody(): Ast {
    this.skip();
    if (this.source[this.index] !== '{') return this.parseExpr();
    this.index += 1;
    this.skip();
    if (this.identWord() !== 'return') throw new ValueError('Use return inside a function body');
    const value = this.parseExpr();
    this.skip();
    if (this.source[this.index] === ';') this.index += 1;
    this.skip();
    if (this.source[this.index] !== '}') throw new ValueError('Missing }');
    this.index += 1;
    return value;
  }

  private args(): Ast[] {
    this.skip();
    if (this.source[this.index] !== '(' && this.source[this.index] !== '[') {
      throw new ValueError('Expected (');
    }
    const open = this.source[this.index];
    const close = open === '(' ? ')' : ']';
    this.index += 1;
    const items: Ast[] = [];
    this.skip();
    if (this.source[this.index] !== close) {
      for (;;) {
        items.push(this.parseExpr());
        this.skip();
        if (this.source[this.index] === ',') {
          this.index += 1;
          this.skip();
          if (this.source[this.index] === close) break;
          continue;
        }
        break;
      }
    }
    this.skip();
    if (this.source[this.index] !== close) throw new ValueError(`Missing ${close}`);
    this.index += 1;
    return items;
  }

  private eqOp(): string | null {
    this.skip();
    const four = this.source.slice(this.index, this.index + 3);
    if (four === '===') {
      this.index += 3;
      return '===';
    }
    if (four === '!==') {
      this.index += 3;
      return '!==';
    }
    const two = this.source.slice(this.index, this.index + 2);
    if (two === '==') {
      this.index += 2;
      return '==';
    }
    if (two === '!=') {
      this.index += 2;
      return '!=';
    }
    if (this.source[this.index] === '=' && this.source[this.index + 1] !== '>') {
      this.index += 1;
      return '==';
    }
    return null;
  }

  private relOp(): string | null {
    this.skip();
    const two = this.source.slice(this.index, this.index + 2);
    if (two === '>=' || two === '<=') {
      this.index += 2;
      return two;
    }
    const one = this.source[this.index];
    if (one === '>' || one === '<') {
      this.index += 1;
      return one;
    }
    return null;
  }

  private operator(op: string): boolean {
    this.skip();
    if (!this.source.startsWith(op, this.index)) return false;
    this.index += op.length;
    return true;
  }

  private ident(): string {
    this.skip();
    const start = this.index;
    if (!this.isIdentStart(this.source[this.index])) return '';
    this.index += 1;
    while (this.isIdentChar(this.source[this.index])) this.index += 1;
    return this.source.slice(start, this.index);
  }

  private identWord(): string {
    const mark = this.index;
    const word = this.ident();
    if (!word) this.index = mark;
    return word;
  }

  private number(): number {
    const start = this.index;
    while (this.source[this.index] >= '0' && this.source[this.index] <= '9') this.index += 1;
    if (this.source[this.index] === '.') {
      this.index += 1;
      while (this.source[this.index] >= '0' && this.source[this.index] <= '9') this.index += 1;
    }
    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value)) throw new ValueError('Invalid number');
    return value;
  }

  private string(quote: string): string {
    this.index += 1;
    let out = '';
    while (this.index < this.source.length && this.source[this.index] !== quote) {
      if (this.source[this.index] === '\\') {
        const next = this.source[this.index + 1];
        out += next === 'n' ? '\n' : next ?? '';
        this.index += 2;
        continue;
      }
      out += this.source[this.index];
      this.index += 1;
    }
    if (this.source[this.index] !== quote) throw new ValueError('Missing end of text');
    this.index += 1;
    return out;
  }

  private skip(): void {
    for (;;) {
      const ch = this.source[this.index];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
        this.index += 1;
        continue;
      }
      if (ch === '/' && this.source[this.index + 1] === '/') {
        this.index += 2;
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1;
        continue;
      }
      if (ch === '/' && this.source[this.index + 1] === '*') {
        this.index += 2;
        while (this.index < this.source.length && !(this.source[this.index] === '*' && this.source[this.index + 1] === '/')) {
          this.index += 1;
        }
        this.index += 2;
        continue;
      }
      return;
    }
  }

  private isIdentStart(ch: string | undefined): boolean {
    return Boolean(ch && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$'));
  }

  private isIdentChar(ch: string | undefined): boolean {
    return this.isIdentStart(ch) || Boolean(ch && ch >= '0' && ch <= '9');
  }
}

function lookup(scope: Scope, name: string): Value {
  for (let current: Scope | null = scope; current; current = current.parent) {
    if (current.bindings.has(name)) return current.bindings.get(name) as Value;
  }
  throw new ValueError(`Unknown name ${name}`);
}

function truthy(value: Value): boolean {
  return value != null && value !== false && value !== 0 && value !== '';
}

function asNum(value: Value): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function equal(left: Value, right: Value, loose: boolean): boolean {
  if (left === right) return typeof left !== 'number' || !Number.isNaN(left);
  if (loose && (typeof left === 'boolean' || typeof right === 'boolean')) {
    const a = asNum(left);
    const b = asNum(right);
    if (a != null && b != null) return a === b;
  }
  return false;
}

function isRow(value: Value): value is { kind: 'row'; fields: Record<string, Value> } {
  return typeof value === 'object' && value != null && !Array.isArray(value) && value.kind === 'row';
}

export function isFn(value: Value): value is { kind: 'fn'; call: (args: Value[]) => Value } {
  return typeof value === 'object' && value != null && !Array.isArray(value) && value.kind === 'fn';
}

function field(value: Value, name: string): Value {
  if (BANNED.has(name)) throw new ValueError(`Property ${name} is not available`);
  if (Array.isArray(value)) {
    if (name === 'length') return value.length;
    throw new ValueError(`List has no property ${name}`);
  }
  if (typeof value === 'string') {
    if (name === 'length') return value.length;
    throw new ValueError(`Text has no property ${name}`);
  }
  if (!isRow(value) || !Object.hasOwn(value.fields, name)) {
    throw new ValueError(`Unknown field ${name}`);
  }
  return value.fields[name];
}

function callFn(value: Value, args: Value[]): Value {
  if (!isFn(value)) throw new ValueError('That value is not a function');
  return value.call(args);
}

function method(list: Value, name: string, args: Value[]): Value {
  if (typeof list === 'string') {
    const text = String(args[0] ?? '');
    if (name === 'includes') return list.includes(text);
    if (name === 'startsWith') return list.startsWith(text);
    if (name === 'endsWith') return list.endsWith(text);
    if (name === 'toLowerCase') return list.toLowerCase();
    if (name === 'toUpperCase') return list.toUpperCase();
    throw new ValueError(`Unknown text method ${name}`);
  }
  if (!Array.isArray(list)) throw new ValueError(`${name} needs a list`);
  const pred = args[0];
  const callPred = (item: Value, index: number) => {
    if (!isFn(pred)) throw new ValueError(`${name} needs a function`);
    return pred.call([item, index]);
  };
  if (name === 'filter') return list.filter((item, index) => truthy(callPred(item, index)));
  if (name === 'map') return list.map((item, index) => callPred(item, index));
  if (name === 'some') return list.some((item, index) => truthy(callPred(item, index)));
  if (name === 'every') return list.every((item, index) => truthy(callPred(item, index)));
  if (name === 'find') return list.find((item, index) => truthy(callPred(item, index))) ?? null;
  if (name === 'includes') return list.some((item) => equal(item, args[0] ?? null, true));
  throw new ValueError(`Unknown list method ${name}`);
}

function evaluate(ast: Ast, scope: Scope): Value {
  throwIfBadgeCancelled();
  switch (ast.k) {
    case 'num':
      return ast.v;
    case 'str':
      return ast.v;
    case 'bool':
      return ast.v;
    case 'null':
      return null;
    case 'name':
      return lookup(scope, ast.name);
    case 'array':
      return ast.items.map((item) => evaluate(item, scope));
    case 'arrow':
      return fn((args) => {
        const bindings = new Map<string, Value>();
        ast.params.forEach((name, index) => bindings.set(name, args[index] ?? null));
        return evaluate(ast.body, { bindings, parent: scope });
      });
    case 'un': {
      const value = evaluate(ast.a, scope);
      if (ast.op === '!') return !truthy(value);
      const num = asNum(value);
      return num == null ? null : -num;
    }
    case 'and': {
      const left = evaluate(ast.a, scope);
      return truthy(left) ? evaluate(ast.b, scope) : left;
    }
    case 'or': {
      const left = evaluate(ast.a, scope);
      return truthy(left) ? left : evaluate(ast.b, scope);
    }
    case 'if':
      return truthy(evaluate(ast.c, scope)) ? evaluate(ast.a, scope) : evaluate(ast.b, scope);
    case 'bin':
      return binary(ast.op, evaluate(ast.a, scope), evaluate(ast.b, scope));
    case 'member': {
      const base = evaluate(ast.a, scope);
      if (base == null && ast.optional) return null;
      try {
        return field(base, ast.name);
      } catch (error) {
        if (ast.optional) return null;
        throw error;
      }
    }
    case 'index': {
      const base = evaluate(ast.a, scope);
      const key = evaluate(ast.key, scope);
      if (Array.isArray(base) && typeof key === 'number') return base[key] ?? null;
      if (typeof key === 'string') return field(base, key);
      throw new ValueError('Index must be a number or a field name');
    }
    case 'call':
      return callFn(evaluate(ast.callee, scope), ast.args.map((arg) => evaluate(arg, scope)));
    case 'method': {
      const base = evaluate(ast.a, scope);
      if (base == null && ast.optional) return null;
      return method(base, ast.name, ast.args.map((arg) => evaluate(arg, scope)));
    }
    default:
      return null;
  }
}

function binary(op: string, left: Value, right: Value): Value {
  if (op === '==' || op === '===') return equal(left, right, op === '==');
  if (op === '!=' || op === '!==') return !equal(left, right, op === '!=');
  if (op === '+' && (typeof left === 'string' || typeof right === 'string')) {
    return `${left ?? ''}${right ?? ''}`;
  }
  const a = asNum(left);
  const b = asNum(right);
  if (a == null || b == null) return false;
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return b === 0 ? null : a / b;
  if (op === '%') return b === 0 ? null : a % b;
  if (op === '>') return a > b;
  if (op === '>=') return a >= b;
  if (op === '<') return a < b;
  if (op === '<=') return a <= b;
  return null;
}
