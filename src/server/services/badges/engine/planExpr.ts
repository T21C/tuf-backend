import { throwIfBadgeCancelled } from '../jobs/cancelSignal.js';
import {
  catalogDifficultyCoverage,
  identitiesFromPasses,
  lookupDifficultyCount,
  ownerDifficultyCounts,
  type OwnerDifficultyCounts,
} from './difficultyCoverage.js';
import { chaseProgress, type ChaseProgress } from './chase.js';
import { difficultyFamily, identityKey, type IdentityMode, type LinkInfo } from './identity.js';
import {
  isAsymmetry,
  isPpMinusOne,
  isSymmetry,
  isTechnicallyPure,
  judgementTotal,
  perfectCount,
} from './judgement.js';
import type { ChartFact, PassFact } from './evaluate.js';
import { parseValueExpr, type Ast } from './valueExpr.js';

export type RowPred =
  | { k: 'all' }
  | { k: 'eq'; f: string; v: string | number | boolean }
  | { k: 'ne'; f: string; v: string | number | boolean }
  | { k: 'cmp'; f: string; op: '<' | '>' | '<=' | '>='; v: number }
  | { k: 'in'; f: string; vs: Array<string | number | boolean> }
  | { k: 'and'; xs: RowPred[] }
  | { k: 'or'; xs: RowPred[] }
  | { k: 'not'; x: RowPred };

export type RollupDemand =
  | { kind: 'coverage'; key: string; label: string; identityMode: IdentityMode }
  | { kind: 'chase'; key: string; exclude: string[] }
  | { kind: 'count'; key: string; pred: RowPred; distinct?: string; identityMode: IdentityMode }
  | { kind: 'maxCount'; key: string; pred: RowPred; field: string; identityMode: IdentityMode }
  | { kind: 'maxGroup'; key: string; pred: RowPred; group: string; value: string; identityMode: IdentityMode };

export type PlanNode =
  | { type: 'lit'; value: number | string | boolean | null }
  | { type: 'slot'; key: string; as: 'number' | 'coverage' | 'chase' }
  | { type: 'member'; a: PlanNode; name: string }
  | { type: 'un'; op: '!' | '-'; a: PlanNode }
  | { type: 'bin'; op: string; a: PlanNode; b: PlanNode }
  | { type: 'and'; a: PlanNode; b: PlanNode }
  | { type: 'or'; a: PlanNode; b: PlanNode }
  | { type: 'if'; c: PlanNode; a: PlanNode; b: PlanNode }
  | { type: 'curve'; credit: PlanNode; start: PlanNode; step: PlanNode; down: boolean }
  | { type: 'result'; tier: PlanNode; credit: PlanNode; from: PlanNode; to: PlanNode }
  | { type: 'ast'; ast: Ast };

export type ValuePlan = {
  demands: RollupDemand[];
  node: PlanNode;
  pure: boolean;
  needClears: boolean;
};

export type RollupSlot = {
  n: number;
  coverage?: { total: number; cleared: number; ratio: number | null; levelIds: number[] };
  chase?: ChaseProgress;
  provingPassIds?: number[];
};

export type RollupSlots = Map<string, RollupSlot>;

export type RollupContext = {
  passes: PassFact[];
  charts: ChartFact[];
  links: Record<number, LinkInfo>;
  ownerId: number;
  difficultyCounts?: OwnerDifficultyCounts;
};

const planCache = new Map<string, ValuePlan>();

function litOf(ast: Ast): string | number | boolean | null | undefined {
  if (ast.k === 'num' || ast.k === 'str' || ast.k === 'bool') return ast.v;
  if (ast.k === 'null') return null;
  return undefined;
}

function callOf(ast: Ast): { name: string; args: Ast[] } | null {
  if (ast.k === 'call' && ast.callee.k === 'name') return { name: ast.callee.name, args: ast.args };
  return null;
}

function methodOf(ast: Ast): { recv: Ast; name: string; args: Ast[] } | null {
  if (ast.k === 'method') return { recv: ast.a, name: ast.name, args: ast.args };
  return null;
}

function fieldOf(ast: Ast, param: string): string | null {
  if (ast.k === 'member' && ast.a.k === 'name' && ast.a.name === param) return ast.name;
  return null;
}

function distinctFieldName(fieldArg: Ast | undefined): string | null {
  if (!fieldArg) return null;
  if (fieldArg.k === 'str') return fieldArg.v;
  if (fieldArg.k === 'name') return fieldArg.name;
  if (fieldArg.k === 'arrow' && fieldArg.params.length === 1) {
    const body = fieldArg.body;
    const param = fieldArg.params[0];
    if (body.k === 'member' && body.a.k === 'name' && body.a.name === param) return body.name;
  }
  return null;
}

function flatten(kind: 'and' | 'or', pred: RowPred): RowPred[] {
  if (pred.k === kind) return pred.xs.flatMap((item) => flatten(kind, item));
  return [pred];
}

function predJson(pred: RowPred): string {
  return JSON.stringify(pred);
}

function sortPreds(items: RowPred[]): RowPred[] {
  return [...items].sort((left, right) => predJson(left).localeCompare(predJson(right)));
}

function uniquePreds(items: RowPred[]): RowPred[] {
  const seen = new Set<string>();
  const out: RowPred[] = [];
  for (const item of items) {
    const key = predJson(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sortInValues(values: Array<string | number | boolean>): Array<string | number | boolean> {
  return [...values].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function canonicalizePred(pred: RowPred): RowPred {
  if (pred.k === 'in') return { k: 'in', f: pred.f, vs: sortInValues([...new Set(pred.vs)]) };
  if (pred.k === 'not') return { k: 'not', x: canonicalizePred(pred.x) };
  if (pred.k === 'and') {
    const items = uniquePreds(sortPreds(flatten('and', pred).map(canonicalizePred).filter((item) => item.k !== 'all')));
    if (!items.length) return { k: 'all' };
    if (items.length === 1) return items[0];
    return { k: 'and', xs: items };
  }
  if (pred.k === 'or') {
    const flat = flatten('or', pred).map(canonicalizePred);
    const byField = new Map<string, Array<string | number | boolean>>();
    const rest: RowPred[] = [];
    for (const item of flat) {
      if (item.k === 'eq') {
        const list = byField.get(item.f) ?? [];
        list.push(item.v);
        byField.set(item.f, list);
        continue;
      }
      if (item.k === 'in') {
        const list = byField.get(item.f) ?? [];
        list.push(...item.vs);
        byField.set(item.f, list);
        continue;
      }
      rest.push(item);
    }
    for (const [field, values] of byField) {
      const unique = sortInValues([...new Set(values)]);
      rest.push(unique.length === 1 ? { k: 'eq', f: field, v: unique[0] } : { k: 'in', f: field, vs: unique });
    }
    const items = uniquePreds(sortPreds(rest));
    if (!items.length) return { k: 'all' };
    if (items.length === 1) return items[0];
    return { k: 'or', xs: items };
  }
  return pred;
}

function asPred(ast: Ast, param: string): RowPred | null {
  if (ast.k === 'bool') return ast.v ? { k: 'all' } : { k: 'not', x: { k: 'all' } };
  if (ast.k === 'and') {
    const left = asPred(ast.a, param);
    const right = asPred(ast.b, param);
    if (!left || !right) return null;
    return canonicalizePred({ k: 'and', xs: [left, right] });
  }
  if (ast.k === 'or') {
    const left = asPred(ast.a, param);
    const right = asPred(ast.b, param);
    if (!left || !right) return null;
    return canonicalizePred({ k: 'or', xs: [left, right] });
  }
  if (ast.k === 'un' && ast.op === '!') {
    const inner = asPred(ast.a, param);
    return inner ? canonicalizePred({ k: 'not', x: inner }) : null;
  }
  if (ast.k !== 'bin') return null;
  const fieldLeft = fieldOf(ast.a, param);
  const fieldRight = fieldOf(ast.b, param);
  const litRight = litOf(ast.b);
  const litLeft = litOf(ast.a);
  const field = fieldLeft ?? fieldRight;
  const lit = fieldLeft != null ? litRight : fieldRight != null ? litLeft : undefined;
  if (field && lit !== undefined && lit !== null) {
    if (ast.op === '==' || ast.op === '===') return { k: 'eq', f: field, v: lit };
    if (ast.op === '!=' || ast.op === '!==') return { k: 'ne', f: field, v: lit };
    if (typeof lit === 'number' && (ast.op === '<' || ast.op === '>' || ast.op === '<=' || ast.op === '>=')) {
      return { k: 'cmp', f: field, op: ast.op, v: lit };
    }
  }
  if (ast.op === 'in' && fieldLeft) {
    if (ast.b.k === 'array') {
      const values: Array<string | number | boolean> = [];
      for (const item of ast.b.items) {
        const value = litOf(item);
        if (value === undefined || value === null) return null;
        values.push(value);
      }
      return canonicalizePred({ k: 'in', f: fieldLeft, vs: values });
    }
  }
  return null;
}

function asClears(ast: Ast): { pred: RowPred } | null {
  if (ast.k === 'name' && ast.name === 'clears') return { pred: { k: 'all' } };
  const method = methodOf(ast);
  if (method?.name === 'filter' && method.args.length === 1 && method.args[0].k === 'arrow' && method.args[0].params.length === 1) {
    const inner = asClears(method.recv);
    const pred = asPred(method.args[0].body, method.args[0].params[0]);
    if (!inner || !pred) return null;
    return { pred: canonicalizePred({ k: 'and', xs: [inner.pred, pred] }) };
  }
  return null;
}

function demandKey(parts: unknown): string {
  return JSON.stringify(parts);
}

function coverageDemand(label: string, identityMode: IdentityMode): RollupDemand {
  const key = demandKey({ kind: 'coverage', label, identityMode });
  return { kind: 'coverage', key, label, identityMode };
}

function countDemand(pred: RowPred, identityMode: IdentityMode, distinct?: string): RollupDemand {
  const key = demandKey({ kind: 'count', pred, identityMode, distinct: distinct ?? null });
  return { kind: 'count', key, pred, identityMode, distinct };
}

function maxCountDemand(pred: RowPred, field: string, identityMode: IdentityMode): RollupDemand {
  const key = demandKey({ kind: 'maxCount', pred, field, identityMode });
  return { kind: 'maxCount', key, pred, field, identityMode };
}

function maxGroupDemand(pred: RowPred, group: string, value: string, identityMode: IdentityMode): RollupDemand {
  const key = demandKey({ kind: 'maxGroup', pred, group, value, identityMode });
  return { kind: 'maxGroup', key, pred, group, value, identityMode };
}

function chaseDemand(exclude: string[]): RollupDemand {
  const names = [...new Set(exclude.filter((name) => name.length > 0))].sort((left, right) => left.localeCompare(right));
  const key = demandKey({ kind: 'chase', exclude: names });
  return { kind: 'chase', key, exclude: names };
}

function asFieldEq(ast: Ast, innerParam: string, outerParam: string): string | null {
  if (ast.k !== 'bin' || (ast.op !== '==' && ast.op !== '===')) return null;
  const left = fieldOf(ast.a, innerParam);
  const right = fieldOf(ast.b, outerParam);
  if (left && right && left === right) return left;
  const swappedLeft = fieldOf(ast.a, outerParam);
  const swappedRight = fieldOf(ast.b, innerParam);
  if (swappedLeft && swappedRight && swappedLeft === swappedRight) return swappedLeft;
  return null;
}

function asNestedMaxCount(ast: Ast): { pred: RowPred; field: string } | null {
  const call = callOf(ast);
  if (!call || call.name !== 'max' || call.args.length !== 1) return null;
  const mapped = methodOf(call.args[0]);
  if (!mapped || mapped.name !== 'map' || mapped.args.length !== 1 || mapped.args[0].k !== 'arrow' || mapped.args[0].params.length !== 1) {
    return null;
  }
  const source = asClears(mapped.recv);
  if (!source) return null;
  const outerParam = mapped.args[0].params[0];
  const body = mapped.args[0].body;
  const countCall = callOf(body);
  if (!countCall || countCall.name !== 'count' || countCall.args.length !== 1) return null;
  const innerFilter = methodOf(countCall.args[0]);
  if (!innerFilter || innerFilter.name !== 'filter' || innerFilter.args.length !== 1 || innerFilter.args[0].k !== 'arrow' || innerFilter.args[0].params.length !== 1) {
    return null;
  }
  const innerSource = asClears(innerFilter.recv);
  if (!innerSource) return null;
  const innerParam = innerFilter.args[0].params[0];
  const field = fieldEqFromFilterBody(innerFilter.args[0].body, innerParam, outerParam, source.pred, innerSource.pred);
  if (!field) return null;
  return { pred: source.pred, field };
}

function fieldEqFromFilterBody(
  ast: Ast,
  innerParam: string,
  outerParam: string,
  sourcePred: RowPred,
  innerPred: RowPred,
): string | null {
  const direct = asFieldEq(ast, innerParam, outerParam);
  if (direct && predJson(innerPred) === predJson(sourcePred)) return direct;
  if (ast.k !== 'and') return null;
  const sides: Array<[Ast, Ast]> = [[ast.a, ast.b], [ast.b, ast.a]];
  for (const [eqSide, predSide] of sides) {
    const field = asFieldEq(eqSide, innerParam, outerParam);
    const extra = asPred(predSide, innerParam);
    if (!field || !extra) continue;
    const full = canonicalizePred({ k: 'and', xs: [innerPred, extra] });
    if (predJson(full) === predJson(sourcePred)) return field;
  }
  return null;
}

type Lowered = { node: PlanNode; demands: RollupDemand[] };

function mergeDemands(list: RollupDemand[][]): RollupDemand[] {
  const seen = new Set<string>();
  const out: RollupDemand[] = [];
  for (const group of list) {
    for (const demand of group) {
      if (seen.has(demand.key)) continue;
      seen.add(demand.key);
      out.push(demand);
    }
  }
  return out;
}

function astNode(ast: Ast): Lowered {
  return { node: { type: 'ast', ast }, demands: [] };
}

function lower(ast: Ast, identityMode: IdentityMode): Lowered {
  if (ast.k === 'num' || ast.k === 'str' || ast.k === 'bool') return { node: { type: 'lit', value: ast.v }, demands: [] };
  if (ast.k === 'null') return { node: { type: 'lit', value: null }, demands: [] };
  if (ast.k === 'un') {
    const inner = lower(ast.a, identityMode);
    if (inner.node.type === 'ast') return astNode(ast);
    return { node: { type: 'un', op: ast.op, a: inner.node }, demands: inner.demands };
  }
  if (ast.k === 'and' || ast.k === 'or') {
    const left = lower(ast.a, identityMode);
    const right = lower(ast.b, identityMode);
    if (left.node.type === 'ast' || right.node.type === 'ast') return astNode(ast);
    return {
      node: { type: ast.k, a: left.node, b: right.node },
      demands: mergeDemands([left.demands, right.demands]),
    };
  }
  if (ast.k === 'bin') {
    const left = lower(ast.a, identityMode);
    const right = lower(ast.b, identityMode);
    if (left.node.type === 'ast' || right.node.type === 'ast') return astNode(ast);
    return {
      node: { type: 'bin', op: ast.op, a: left.node, b: right.node },
      demands: mergeDemands([left.demands, right.demands]),
    };
  }
  if (ast.k === 'if') {
    const cond = lower(ast.c, identityMode);
    const left = lower(ast.a, identityMode);
    const right = lower(ast.b, identityMode);
    if (cond.node.type === 'ast' || left.node.type === 'ast' || right.node.type === 'ast') return astNode(ast);
    return {
      node: { type: 'if', c: cond.node, a: left.node, b: right.node },
      demands: mergeDemands([cond.demands, left.demands, right.demands]),
    };
  }
  if (ast.k === 'member') {
    const inner = lower(ast.a, identityMode);
    if (inner.node.type === 'ast') return astNode(ast);
    return { node: { type: 'member', a: inner.node, name: ast.name }, demands: inner.demands };
  }
  const call = callOf(ast);
  if (call?.name === 'difficulty' && call.args.length === 1 && call.args[0].k === 'str') {
    const demand = coverageDemand(call.args[0].v, identityMode);
    return { node: { type: 'slot', key: demand.key, as: 'coverage' }, demands: [demand] };
  }
  if (call?.name === 'chase' && call.args.every((arg) => arg.k === 'str')) {
    const demand = chaseDemand(call.args.map((arg) => arg.k === 'str' ? arg.v : ''));
    return { node: { type: 'slot', key: demand.key, as: 'chase' }, demands: [demand] };
  }
  if (call?.name === 'count' && call.args.length === 1) {
    const clears = asClears(call.args[0]);
    if (clears) {
      const demand = countDemand(clears.pred, identityMode);
      return { node: { type: 'slot', key: demand.key, as: 'number' }, demands: [demand] };
    }
    const distinct = methodOf(call.args[0]);
    if (distinct?.name === 'distinct' || (callOf(call.args[0])?.name === 'distinct')) {
      const distinctCall = callOf(call.args[0]);
      const recv = distinct?.recv ?? distinctCall?.args[0];
      const fieldArg = distinct?.args[0] ?? distinctCall?.args[1];
      const field = distinctFieldName(fieldArg);
      if (recv && field) {
        const clearsList = asClears(recv);
        if (clearsList) {
          const demand = countDemand(clearsList.pred, identityMode, field);
          return { node: { type: 'slot', key: demand.key, as: 'number' }, demands: [demand] };
        }
      }
    }
  }
  if (call?.name === 'maxCount' && call.args.length === 2 && call.args[1].k === 'str') {
    const clears = asClears(call.args[0]);
    if (clears) {
      const demand = maxCountDemand(clears.pred, call.args[1].v, identityMode);
      return { node: { type: 'slot', key: demand.key, as: 'number' }, demands: [demand] };
    }
  }
  if (call?.name === 'maxGroup' && call.args.length === 3 && call.args[1].k === 'str' && call.args[2].k === 'str') {
    const clears = asClears(call.args[0]);
    if (clears) {
      const demand = maxGroupDemand(clears.pred, call.args[1].v, call.args[2].v, identityMode);
      return { node: { type: 'slot', key: demand.key, as: 'number' }, demands: [demand] };
    }
  }
  const nested = asNestedMaxCount(ast);
  if (nested) {
    const demand = maxCountDemand(nested.pred, nested.field, identityMode);
    return { node: { type: 'slot', key: demand.key, as: 'number' }, demands: [demand] };
  }
  if (call?.name === 'curve' || call?.name === 'curveDown') {
    if (call.args.length >= 3) {
      const credit = lower(call.args[0], identityMode);
      const start = lower(call.args[1], identityMode);
      const step = lower(call.args[2], identityMode);
      if (credit.node.type !== 'ast' && start.node.type !== 'ast' && step.node.type !== 'ast') {
        return {
          node: { type: 'curve', credit: credit.node, start: start.node, step: step.node, down: call.name === 'curveDown' },
          demands: mergeDemands([credit.demands, start.demands, step.demands]),
        };
      }
    }
  }
  if (call?.name === 'result' && call.args.length >= 1) {
    const parts = call.args.map((arg) => lower(arg, identityMode));
    if (parts.every((part) => part.node.type !== 'ast')) {
      const lit = (value: number): PlanNode => ({ type: 'lit', value });
      return {
        node: {
          type: 'result',
          tier: parts[0].node,
          credit: parts[1]?.node ?? parts[0].node,
          from: parts[2]?.node ?? lit(0),
          to: parts[3]?.node ?? lit(1),
        },
        demands: mergeDemands(parts.map((part) => part.demands)),
      };
    }
  }
  return astNode(ast);
}

function nodeHasAst(node: PlanNode): boolean {
  switch (node.type) {
    case 'ast':
      return true;
    case 'lit':
    case 'slot':
      return false;
    case 'member':
    case 'un':
      return nodeHasAst(node.a);
    case 'bin':
    case 'and':
    case 'or':
      return nodeHasAst(node.a) || nodeHasAst(node.b);
    case 'if':
      return nodeHasAst(node.c) || nodeHasAst(node.a) || nodeHasAst(node.b);
    case 'curve':
      return nodeHasAst(node.credit) || nodeHasAst(node.start) || nodeHasAst(node.step);
    case 'result':
      return nodeHasAst(node.tier) || nodeHasAst(node.credit) || nodeHasAst(node.from) || nodeHasAst(node.to);
    default:
      return true;
  }
}

function astNeedsClears(ast: Ast): boolean {
  const names = new Set<string>();
  const walk = (node: Ast, bound: Set<string>) => {
    switch (node.k) {
      case 'name':
        if (!bound.has(node.name)) names.add(node.name);
        return;
      case 'array':
        for (const item of node.items) walk(item, bound);
        return;
      case 'arrow': {
        const next = new Set(bound);
        for (const param of node.params) next.add(param);
        walk(node.body, next);
        return;
      }
      case 'un':
        walk(node.a, bound);
        return;
      case 'bin':
      case 'and':
      case 'or':
        walk(node.a, bound);
        walk(node.b, bound);
        return;
      case 'if':
        walk(node.c, bound);
        walk(node.a, bound);
        walk(node.b, bound);
        return;
      case 'member':
        walk(node.a, bound);
        return;
      case 'index':
        walk(node.a, bound);
        walk(node.key, bound);
        return;
      case 'call':
        walk(node.callee, bound);
        for (const arg of node.args) walk(arg, bound);
        return;
      case 'method':
        walk(node.a, bound);
        for (const arg of node.args) walk(arg, bound);
        return;
      default:
        return;
    }
  };
  walk(ast, new Set());
  return names.has('clears') || names.has('sequence') || names.has('consecutive') || names.has('gap') || names.has('prefix');
}

function nodeNeedsClears(node: PlanNode): boolean {
  if (node.type === 'ast') return astNeedsClears(node.ast);
  switch (node.type) {
    case 'lit':
    case 'slot':
      return false;
    case 'member':
    case 'un':
      return nodeNeedsClears(node.a);
    case 'bin':
    case 'and':
    case 'or':
      return nodeNeedsClears(node.a) || nodeNeedsClears(node.b);
    case 'if':
      return nodeNeedsClears(node.c) || nodeNeedsClears(node.a) || nodeNeedsClears(node.b);
    case 'curve':
      return nodeNeedsClears(node.credit) || nodeNeedsClears(node.start) || nodeNeedsClears(node.step);
    case 'result':
      return nodeNeedsClears(node.tier) || nodeNeedsClears(node.credit) || nodeNeedsClears(node.from) || nodeNeedsClears(node.to);
    default:
      return true;
  }
}

export function planValueExpr(ast: Ast, options?: { identityMode?: IdentityMode; source?: string }): ValuePlan {
  const identityMode = options?.identityMode ?? 'level';
  const cacheKey = options?.source != null ? `${identityMode}\n${options.source}` : null;
  if (cacheKey) {
    const cached = planCache.get(cacheKey);
    if (cached) return cached;
  }
  const lowered = lower(ast, identityMode);
  const plan: ValuePlan = {
    demands: lowered.demands,
    node: lowered.node,
    pure: !nodeHasAst(lowered.node),
    needClears: nodeNeedsClears(lowered.node),
  };
  if (cacheKey) planCache.set(cacheKey, plan);
  return plan;
}

export function planValueSource(source: string, identityMode: IdentityMode = 'level'): ValuePlan | null {
  const parsed = parseValueExpr(source);
  if (!parsed.ok) return null;
  return planValueExpr(parsed.ast, { identityMode, source });
}

export function unionDemands(plans: Array<ValuePlan | null | undefined>): RollupDemand[] {
  return mergeDemands(plans.map((plan) => plan?.demands ?? []));
}

export function planSummary(plan: ValuePlan): { pure: boolean; ops: string[] } {
  const ops = plan.demands.map((demand) => {
    if (demand.kind === 'coverage') return `coverage(${JSON.stringify(demand.label)})`;
    if (demand.kind === 'chase') return `chase(${demand.exclude.map((name) => JSON.stringify(name)).join(',')})`;
    if (demand.kind === 'count') return demand.distinct ? `count(distinct ${demand.distinct})` : 'count';
    if (demand.kind === 'maxCount') return `maxCount(${demand.field})`;
    return `maxGroup(${demand.group},${demand.value})`;
  });
  return { pure: plan.pure, ops };
}

function identityOf(pass: PassFact, ctx: RollupContext, mode: IdentityMode): string {
  return identityKey(mode, pass.levelId, ctx.links[pass.levelId] ?? null);
}

function passField(
  pass: PassFact,
  ctx: RollupContext,
  mode: IdentityMode,
  field: string,
  chart?: ChartFact,
): string | number | boolean | null {
  const resolved = chart ?? ctx.charts.find((item) => item.id === pass.levelId);
  const sheet = pass.judgements;
  const pure = pass.accuracy != null && pass.accuracy >= 1 - 1e-9;
  const when = pass.uploadTimeKnown && pass.vidUploadTime ? new Date(pass.vidUploadTime) : null;
  switch (field) {
    case 'passId': return pass.id;
    case 'levelId': return pass.levelId;
    case 'identity': return identityOf(pass, ctx, mode);
    case 'speed': return pass.speed;
    case 'accuracy': return pass.ancient ? null : pass.accuracy;
    case 'score': return pass.ancient ? null : pass.scoreV2;
    case 'keyCount': return pass.keyCount;
    case 'difficulty': return pass.difficultyNowName;
    case 'difficultyAt': return pass.difficultyAtName;
    case 'family': return difficultyFamily(pass.difficultyNowName);
    case 'familyAt': return difficultyFamily(pass.difficultyAtName);
    case 'songId': return resolved?.songId ?? null;
    case 'durationMs': return pass.durationMs ?? resolved?.durationMs ?? null;
    case 'worldsFirst': return Boolean(pass.isWorldsFirst && Number(pass.speed) === 1);
    case 'isWorldsFirst': return Boolean(pass.isWorldsFirst);
    case 'worldsFirstPP': return pass.isWorldsFirstPP;
    case 'ancient': return pass.ancient;
    case 'xPerfect': return pass.isXPerfectMode;
    case 'month': return when ? when.getUTCMonth() + 1 : null;
    case 'day': return when ? when.getUTCDate() : null;
    case 'uploadMs': return when ? when.getTime() : null;
    case 'charterCount': return resolved?.charterIds.length ?? 0;
    case 'vfxerCount': return resolved?.vfxerIds.length ?? 0;
    case 'reference': return Boolean(resolved?.isReference);
    case 'ownerIsCharter': return Boolean(resolved?.charterIds.includes(ctx.ownerId));
    case 'ownerIsVfxer': return Boolean(resolved?.vfxerIds.includes(ctx.ownerId));
    case 'purePerfect': return pass.ancient ? false : pure;
    case 'ppMinusOne': return pass.ancient ? false : isPpMinusOne(sheet, pass.isXPerfectMode);
    case 'noMisses': return pass.ancient ? false : sheet.earlyDouble === 0 && judgementTotal(sheet) > 0;
    case 'symmetry': return pass.ancient ? false : isSymmetry(sheet, pure);
    case 'technicallyPure': return pass.ancient ? false : isTechnicallyPure(sheet);
    case 'noPerfects': return pass.ancient ? false : perfectCount(sheet, pass.isXPerfectMode) === 0 && judgementTotal(sheet) > 0;
    case 'asymmetry': return pass.ancient ? false : isAsymmetry(sheet, pass.isXPerfectMode);
    default: return null;
  }
}

function sameAtom(left: unknown, right: string | number | boolean): boolean {
  if (left == null) return false;
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right);
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  return String(left) === String(right);
}

function matchPred(pred: RowPred, pass: PassFact, ctx: RollupContext, mode: IdentityMode, chart?: ChartFact): boolean {
  switch (pred.k) {
    case 'all':
      return true;
    case 'eq':
      return sameAtom(passField(pass, ctx, mode, pred.f, chart), pred.v);
    case 'ne':
      return !sameAtom(passField(pass, ctx, mode, pred.f, chart), pred.v);
    case 'cmp': {
      const value = passField(pass, ctx, mode, pred.f, chart);
      if (typeof value !== 'number') return false;
      if (pred.op === '<') return value < pred.v;
      if (pred.op === '>') return value > pred.v;
      if (pred.op === '<=') return value <= pred.v;
      return value >= pred.v;
    }
    case 'in':
      return pred.vs.some((value) => sameAtom(passField(pass, ctx, mode, pred.f, chart), value));
    case 'and':
      return pred.xs.every((item) => matchPred(item, pass, ctx, mode, chart));
    case 'or':
      return pred.xs.some((item) => matchPred(item, pass, ctx, mode, chart));
    case 'not':
      return !matchPred(pred.x, pass, ctx, mode, chart);
    default:
      return false;
  }
}

export function computeRollups(ctx: RollupContext, demands: RollupDemand[]): RollupSlots {
  const slots: RollupSlots = new Map();
  const coverage = demands.filter((demand): demand is Extract<RollupDemand, { kind: 'coverage' }> => demand.kind === 'coverage');
  const chases = demands.filter((demand): demand is Extract<RollupDemand, { kind: 'chase' }> => demand.kind === 'chase');
  const walks = demands.filter((demand): demand is Exclude<RollupDemand, { kind: 'coverage' | 'chase' }> => demand.kind !== 'coverage' && demand.kind !== 'chase');
  for (const demand of coverage) {
    const table = catalogDifficultyCoverage(ctx.charts, ctx.links, demand.identityMode);
    const counts = ctx.difficultyCounts?.[demand.identityMode]
      ?? ownerDifficultyCounts(table, identitiesFromPasses(table, ctx.links, ctx.passes));
    const count = lookupDifficultyCount(counts, demand.label);
    slots.set(demand.key, {
      n: count.cleared,
      coverage: {
        total: count.total,
        cleared: count.cleared,
        ratio: count.ratio,
        levelIds: table.byName.get(demand.label)?.levelIds ?? [],
      },
    });
  }
  if (chases.length) {
    const clearedIds = ctx.passes.map((pass) => pass.levelId);
    for (const demand of chases) {
      const progress = chaseProgress(ctx.charts, clearedIds, demand.exclude);
      slots.set(demand.key, { n: progress.credit, chase: progress });
    }
  }
  if (!walks.length) return slots;

  type CountAgg = { n: number; seen: Set<string>; proving: number[] };
  type MaxCountAgg = Map<string, number[]>;
  type MaxGroupAgg = Map<string, Set<string>>;
  const countAggs = new Map<string, CountAgg>();
  const maxCountAggs = new Map<string, MaxCountAgg>();
  const maxGroupAggs = new Map<string, MaxGroupAgg>();
  for (const demand of walks) {
    if (demand.kind === 'count') countAggs.set(demand.key, { n: 0, seen: new Set(), proving: [] });
    if (demand.kind === 'maxCount') maxCountAggs.set(demand.key, new Map());
    if (demand.kind === 'maxGroup') maxGroupAggs.set(demand.key, new Map());
  }

  const chartById = new Map(ctx.charts.map((chart) => [chart.id, chart]));
  for (let index = 0; index < ctx.passes.length; index += 1) {
    if ((index & 127) === 0) throwIfBadgeCancelled();
    const pass = ctx.passes[index];
    const chart = chartById.get(pass.levelId);
    for (const demand of walks) {
      if (!matchPred(demand.pred, pass, ctx, demand.identityMode, chart)) continue;
      if (demand.kind === 'count') {
        const agg = countAggs.get(demand.key);
        if (!agg) continue;
        if (demand.distinct) {
          const key = String(passField(pass, ctx, demand.identityMode, demand.distinct, chart) ?? '');
          if (agg.seen.has(key)) continue;
          agg.seen.add(key);
        }
        agg.n += 1;
        agg.proving.push(pass.id);
        continue;
      }
      if (demand.kind === 'maxCount') {
        const groups = maxCountAggs.get(demand.key);
        if (!groups) continue;
        const key = String(passField(pass, ctx, demand.identityMode, demand.field, chart) ?? '');
        const bucket = groups.get(key);
        if (bucket) bucket.push(pass.id);
        else groups.set(key, [pass.id]);
        continue;
      }
      const groups = maxGroupAggs.get(demand.key);
      if (!groups || demand.kind !== 'maxGroup') continue;
      const group = String(passField(pass, ctx, demand.identityMode, demand.group, chart) ?? '');
      const value = String(passField(pass, ctx, demand.identityMode, demand.value, chart) ?? '');
      const set = groups.get(group) ?? new Set<string>();
      set.add(value);
      groups.set(group, set);
    }
  }

  for (const demand of walks) {
    if (demand.kind === 'count') {
      const agg = countAggs.get(demand.key);
      slots.set(demand.key, { n: agg?.n ?? 0, provingPassIds: agg?.proving ?? [] });
    } else if (demand.kind === 'maxCount') {
      const groups = maxCountAggs.get(demand.key);
      let best: number[] = [];
      for (const bucket of groups?.values() ?? []) {
        if (bucket.length > best.length) best = bucket;
      }
      slots.set(demand.key, { n: best.length, provingPassIds: best });
    } else if (demand.kind === 'maxGroup') {
      const groups = maxGroupAggs.get(demand.key);
      let best = 0;
      for (const set of groups?.values() ?? []) best = Math.max(best, set.size);
      slots.set(demand.key, { n: best });
    }
  }
  return slots;
}

export function collectPlanSlotKeys(node: PlanNode, into: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'slot':
      into.add(node.key);
      return into;
    case 'lit':
    case 'ast':
      return into;
    case 'member':
    case 'un':
      return collectPlanSlotKeys(node.a, into);
    case 'bin':
    case 'and':
    case 'or':
      collectPlanSlotKeys(node.a, into);
      return collectPlanSlotKeys(node.b, into);
    case 'if':
      collectPlanSlotKeys(node.c, into);
      collectPlanSlotKeys(node.a, into);
      return collectPlanSlotKeys(node.b, into);
    case 'curve':
      collectPlanSlotKeys(node.credit, into);
      collectPlanSlotKeys(node.start, into);
      return collectPlanSlotKeys(node.step, into);
    case 'result':
      collectPlanSlotKeys(node.tier, into);
      collectPlanSlotKeys(node.credit, into);
      collectPlanSlotKeys(node.from, into);
      return collectPlanSlotKeys(node.to, into);
    default:
      return into;
  }
}
