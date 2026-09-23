import Pass from '@/models/passes/Pass.js';
import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';
import { passPlayerAvatarProxyUrl } from '@/server/services/elasticsearch/misc/sequelizeIncludes.js';

/** Plain row for ES: never spread Sequelize models (they carry include/parent cycles). */
function plainRow<T extends object>(row: T): Record<string, unknown> {
  const m = row as unknown as { get?: (opts: { plain: true }) => unknown };
  if (typeof m.get === 'function') {
    return m.get({ plain: true }) as Record<string, unknown>;
  }
  return { ...(row as Record<string, unknown>) };
}

function pua(value: unknown): string {
  return convertToPUA(value == null ? '' : String(value));
}

function puaOrNull(value: unknown): string | null {
  if (value == null) return null;
  return pua(value);
}

function arr<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function omitXaccuracy(row: any) {
  const {xaccuracy: _xaccuracy, ...rest} = row || {};
  return rest;
}

export function buildPassIndexDocument(pass: Pass): any {
  const p = omitXaccuracy(pass.toJSON());
  const level = p.level;
  const xaccuracyRaw = pass.getDataValue('xaccuracy');
  const xaccuracy = xaccuracyRaw == null ? null : Number(xaccuracyRaw);

  return {
    ...p,
    xaccuracy: Number.isFinite(xaccuracy) ? xaccuracy : null,
    adofaiVersion: Number(p.adofaiVersion) || 2,
    isXPerfectMode: !!p.isXPerfectMode,
    isWrongJudgement: !!p.isWrongJudgement,
    passMetaFlags: Number(p.passMetaFlags) || 0,
    vidTitle: puaOrNull(p.vidTitle),
    videoLink: puaOrNull(p.videoLink),
    player: p.player
      ? {
          ...plainRow(p.player),
          name: pua(p.player.name),
          username: p.player.user?.username ?? null,
          avatarUrl: passPlayerAvatarProxyUrl(p.player.id),
        }
      : null,
    level: level
      ? {
          ...plainRow(level),
          song: pua(level.song),
          artist: pua(level.artist),
          dlLink: puaOrNull(level.dlLink),
          // Match level-index PUA encoding so multi-word aliases survive whitespace tokenization.
          aliases: arr<any>(level.aliases).map((a) => {
            const row = plainRow(a);
            return {
              ...row,
              originalValue:
                row.originalValue != null ? pua(row.originalValue) : row.originalValue,
              alias: pua(row.alias),
            };
          }),
        }
      : null,
    judgements: p.judgements
      ? omitXaccuracy({
          ...plainRow(p.judgements),
          perfectMinus: Number(p.judgements.perfectMinus) || 0,
          perfectPlus: Number(p.judgements.perfectPlus) || 0,
        })
      : null,
  };
}
