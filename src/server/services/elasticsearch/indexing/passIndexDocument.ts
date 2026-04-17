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

export function buildPassIndexDocument(pass: Pass): any {
  const p = pass.toJSON() as any;

  return {
    ...p,
    vidTitle: puaOrNull(p.vidTitle),
    videoLink: puaOrNull(p.videoLink),
    player: p.player
      ? {
          ...plainRow(p.player as object),
          name: pua((p.player as any).name),
          username: (p.player as any).user?.username ?? null,
          avatarUrl: passPlayerAvatarProxyUrl((p.player as any).id),
        }
      : null,
    level: p.level
      ? {
          ...plainRow(p.level as object),
          song: pua((p.level as any).song),
          artist: pua((p.level as any).artist),
        }
      : null,
  };
}
