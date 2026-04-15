import { Op } from 'sequelize';

/**
 * Normalize Sequelize `where` field values (plain scalar, Op.in, Op.eq) into
 * unique positive finite numeric IDs. Used by bulk-update hooks where `where.id`
 * is not always a plain number (e.g. `{ [Op.in]: [...] }`).
 */
export function extractNumericIdsFromSequelizeWhereField(field: unknown): number[] {
  if (field == null || field === false) {
    return [];
  }
  if (typeof field === 'number') {
    return Number.isFinite(field) && field > 0 ? [field] : [];
  }
  if (typeof field === 'string') {
    const n = Number(field);
    return Number.isFinite(n) && n > 0 ? [n] : [];
  }
  if (typeof field === 'object' && field !== null) {
    const o = field as { [Op.in]?: unknown; [Op.eq]?: unknown };
    const inVal = o[Op.in];
    if (Array.isArray(inVal)) {
      const out: number[] = [];
      for (const v of inVal) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          out.push(n);
        }
      }
      return [...new Set(out)].sort((a, b) => a - b);
    }
    const eqVal = o[Op.eq];
    if (eqVal !== undefined && eqVal !== null) {
      const n = Number(eqVal);
      return Number.isFinite(n) && n > 0 ? [n] : [];
    }
  }
  return [];
}
