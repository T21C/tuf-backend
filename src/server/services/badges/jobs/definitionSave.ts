import type { BackfillMode } from '../engine/params.js';

export function definitionExpression(params: unknown): string {
  let raw: unknown = params;
  if (typeof raw === 'string') {
    const text = raw.trim();
    try {
      raw = JSON.parse(raw);
    } catch {
      return text;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const src = raw as Record<string, unknown>;
  const nested = (value: unknown): string => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const expression = (value as Record<string, unknown>).expression;
    return typeof expression === 'string' ? expression.trim() : '';
  };
  if (typeof src.expression === 'string' && src.expression.trim()) return src.expression.trim();
  return nested(src.pattern) || nested(src.sequence);
}

export function shouldEnqueueOnSave(args: {
  previousExpression: string | null;
  nextBackfill: BackfillMode;
  nextParams: unknown;
}): boolean {
  if (args.nextBackfill === 'forward') return false;
  if (args.previousExpression != null && definitionExpression(args.nextParams) === args.previousExpression) {
    return false;
  }
  return args.nextBackfill === 'now' || args.nextBackfill === 'queue';
}
