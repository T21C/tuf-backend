import Level from '@/models/levels/Level.js';
import LevelTag from '@/models/levels/LevelTag.js';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';
import { formatCreatorDisplay } from '@/misc/utils/Utility.js';
import {
  pickThemeCuration,
  sortCurationsByTypeOrder,
} from '@/misc/utils/data/curationOrdering.js';

function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function pua(value: unknown): string {
  return convertToPUA(value == null ? '' : String(value));
}

function puaOrNull(value: unknown): string | null {
  if (value == null) return null;
  return pua(value);
}

function typeIdsFromCurationTypes(
  types: CurationType[] | null | undefined
): number[] {
  const ids = (types || [])
    .map((t) => t.id)
    .filter((id): id is number => id != null);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Plain row for ES: never spread Sequelize models (they carry include/parent cycles). */
function plainRow<T extends object>(row: T): Record<string, unknown> {
  const m = row as unknown as { get?: (opts: { plain: true }) => unknown };
  if (typeof m.get === 'function') {
    return m.get({ plain: true }) as Record<string, unknown>;
  }
  return { ...(row as Record<string, unknown>) };
}

export function buildLevelIndexDocument(level: Level): any {
  // toJSON() recursively serializes nested associations; plain snapshots can still hold
  // Sequelize instances when relations were injected via setDataValue (bulk index).
  const l = level.toJSON() as any;

  const songObject = l.songObject ?? null;
  const teamObject = l.teamObject ?? null;

  const artists = arr<any>(songObject?.credits).map((credit) => {
    const cr = plainRow(credit as object) as any;
    const a = cr?.artist;
    return {
      id: a?.id ?? null,
      name: pua(a?.name),
      avatarUrl: a?.avatarUrl ?? null,
      verificationState: a?.verificationState ?? null,
      role: cr?.role ?? null,
      aliases: arr<any>(a?.aliases).map((al) => ({ alias: pua((plainRow(al as object) as any).alias ?? al) })),
    };
  });

  const team = pua(teamObject?.name);
  const creator = pua(
    formatCreatorDisplay({
      ...l,
      team,
      levelCredits: arr(l.levelCredits),
    } as any),
  );

  const bpm =
    typeof l.bpm === 'number' && Number.isFinite(l.bpm) ? l.bpm : null;
  const tilecount =
    typeof l.tilecount === 'number' && Number.isFinite(l.tilecount)
      ? Math.floor(l.tilecount)
      : null;
  const levelLengthInMs =
    typeof l.levelLengthInMs === 'number' && Number.isFinite(l.levelLengthInMs)
      ? l.levelLengthInMs
      : null;

  const {
    bpm: _bpmCol,
    tilecount: _tileCol,
    levelLengthInMs: _levelLengthCol,
    ...levelRest
  } = l as any;

  return {
    ...levelRest,
    bpm,
    tilecount,
    levelLengthInMs,
    song: pua(l.song),
    artist: pua(l.artist),
    songId: l.songId || null,
    suffix: puaOrNull(l.suffix),
    songObject: songObject
      ? {
          id: songObject.id ?? null,
          name: pua(songObject.name),
          verificationState: songObject.verificationState ?? null,
          aliases: arr<any>(songObject.aliases).map((al) => ({
            alias: pua((plainRow(al as object) as any).alias ?? al),
          })),
        }
      : null,
    artists: artists.length ? artists : null,
    team,
    videoLink: puaOrNull(l.videoLink),
    dlLink: puaOrNull(l.dlLink),
    legacyDllink: puaOrNull(l.legacyDllink),
    aliases: arr<any>(l.aliases).map((a) => {
      const row = plainRow(a as object);
      return {
        ...row,
        originalValue:
          row.originalValue != null ? pua(row.originalValue) : row.originalValue,
        alias: pua((row as any).alias),
      };
    }),
    creator,
    levelCredits: arr<any>(l.levelCredits).map((credit) => {
      const row = plainRow(credit as object) as any;
      const c = row?.creator;
      return {
        ...row,
        creator: c
          ? {
              ...plainRow(c as object),
              name: pua(c.name),
              creatorAliases: arr<any>(c.creatorAliases).map((al) => ({
                ...plainRow(al as object),
                name: pua((al as any)?.name ?? al),
              })),
            }
          : null,
      };
    }),
    rating: (() => {
      const r0 = arr<any>(l.ratings)[0];
      return r0 ? plainRow(r0 as object) : {};
    })(),
    teamObject: teamObject
      ? {
          ...plainRow(teamObject as object),
          name: pua(teamObject.name),
          aliases: arr<any>(teamObject.teamAliases).map((al) => ({
            ...plainRow(al as object),
            name: pua((al as any)?.name ?? al),
          })),
        }
      : null,
    curations: (() => {
      const raw = arr<Curation>(l.curations);
      const sorted = sortCurationsByTypeOrder(raw);
      return sorted.map((c) => {
        const cPlain = plainRow(c as unknown as object) as Record<string, unknown> & {
          types?: unknown;
        };
        const typeIds = typeIdsFromCurationTypes(((cPlain as any).types || []) as CurationType[]);
        delete (cPlain as any).types;
        return {
          ...cPlain,
          typeIds,
        };
      });
    })(),
    curation: (() => {
      const raw = arr<Curation>(l.curations);
      const sorted = sortCurationsByTypeOrder(raw);
      const theme = pickThemeCuration(sorted);
      if (!theme) return null;
      const themePlain = plainRow(theme as unknown as object) as Record<string, unknown> & {
        types?: unknown;
      };
      const typeIds = typeIdsFromCurationTypes(((themePlain as any).types || []) as CurationType[]);
      delete (themePlain as any).types;
      return {
        ...themePlain,
        typeIds,
      };
    })(),
    isCurated: arr(l.curations).length > 0,
    tags: arr<LevelTag>(l.tags).map((tag: any) => {
      const t = plainRow(tag as object) as any;
      return {
        id: t.id,
        name: t.name,
        icon: t.icon,
        color: t.color,
        group: t.group,
      };
    }),
  };
}
