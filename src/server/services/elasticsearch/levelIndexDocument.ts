import Level from '@/models/levels/Level.js';
import LevelTag from '@/models/levels/LevelTag.js';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';
import { formatCreatorDisplay } from '@/misc/utils/Utility.js';
import {
  pickThemeCuration,
  pickThemeTypeForCuration,
  sortCurationTypesByOrder,
  sortCurationsByTypeOrder,
} from '@/misc/utils/data/curationOrdering.js';

export function buildLevelIndexDocument(level: Level): any {
  const artists =
    level.songObject?.credits?.map(credit => ({
      id: credit.artist.id,
      name: convertToPUA(credit.artist.name),
      avatarUrl: credit.artist.avatarUrl,
      verificationState: credit.artist.verificationState,
      role: credit.role,
      aliases:
        credit.artist.aliases?.map(alias => ({
          alias: convertToPUA(alias.alias),
        })) || [],
    })) || [];

  return {
    ...level.get({ plain: true }),
    song: convertToPUA(level.song),
    artist: convertToPUA(level.artist),
    songId: level.songId || null,
    suffix: level.suffix ? convertToPUA(level.suffix) : null,
    songObject: level.songObject
      ? {
          ...level.songObject.get({ plain: true }),
          name: convertToPUA(level.songObject.name),
          verificationState: level.songObject.verificationState,
          aliases: level.songObject.aliases?.map(alias => ({
            ...alias.get({ plain: true }),
            alias: convertToPUA(alias.alias),
          })),
        }
      : null,
    artists:
      artists.length > 0
        ? artists.map(artist => ({
            ...artist,
            name: convertToPUA(artist.name),
            avatarUrl: artist.avatarUrl,
            verificationState: artist.verificationState,
            role: artist.role,
            aliases: artist.aliases?.map(alias => ({
              alias: convertToPUA(alias.alias),
            })),
          }))
        : null,
    team: convertToPUA(level.teamObject?.name),
    videoLink: level.videoLink ? convertToPUA(level.videoLink) : null,
    dlLink: level.dlLink ? convertToPUA(level.dlLink) : null,
    legacyDllink: level.legacyDllink ? convertToPUA(level.legacyDllink) : null,
    aliases: level.aliases?.map(alias => ({
      alias: convertToPUA(alias.alias),
    })),
    creator: convertToPUA(formatCreatorDisplay(level)),
    levelCredits: level.levelCredits?.map(credit => ({
      ...credit.get({ plain: true }),
      creator: credit.creator
        ? {
            ...credit.creator.get({ plain: true }),
            name: convertToPUA(credit.creator.name),
            creatorAliases: credit.creator.creatorAliases?.map(alias => ({
              ...alias.get({ plain: true }),
              name: convertToPUA(alias.name),
            })),
          }
        : null,
    })),
    rating: {
      ...level.ratings?.[0]?.get({ plain: true }),
    },
    teamObject: level.teamObject
      ? {
          ...level.teamObject.get({ plain: true }),
          name: convertToPUA(level.teamObject.name),
          aliases: level.teamObject.teamAliases?.map(alias => ({
            ...alias.get({ plain: true }),
            name: convertToPUA(alias.name),
          })),
        }
      : null,
    curations: (() => {
      const raw = ((level as unknown) as { curations?: Curation[] }).curations || [];
      const sorted = sortCurationsByTypeOrder(raw);
      return sorted.map(c => {
        const typesPlain = sortCurationTypesByOrder((c.types || []) as CurationType[]).map(t => ({
          ...t.get({ plain: true }),
          abilities: (t.abilities as bigint).toString(),
        }));
        const typeIds = typesPlain.map(x => x.id);
        const plain = c.get({ plain: true }) as unknown as Record<string, unknown>;
        delete plain.types;
        return {
          ...plain,
          typeIds,
          types: typesPlain,
        };
      });
    })(),
    curation: (() => {
      const raw = ((level as unknown) as { curations?: Curation[] }).curations || [];
      const sorted = sortCurationsByTypeOrder(raw);
      const theme = pickThemeCuration(sorted);
      if (!theme) return null;
      const t = pickThemeTypeForCuration(theme);
      const typesPlain = sortCurationTypesByOrder((theme.types || []) as CurationType[]).map(ty => ({
        ...ty.get({ plain: true }),
        abilities: (ty.abilities as bigint).toString(),
      }));
      const typeIds = typesPlain.map(x => x.id);
      const plain = theme.get({ plain: true }) as unknown as Record<string, unknown>;
      delete plain.types;
      return {
        ...plain,
        typeIds,
        types: typesPlain,
        type: t
          ? {
              ...t.get({ plain: true }),
              abilities: (t.abilities as bigint).toString(),
            }
          : null,
      };
    })(),
    isCurated: (((level as unknown) as { curations?: Curation[] }).curations?.length ?? 0) > 0,
    tags:
      ((level as any).tags as LevelTag[] | undefined)?.map((tag: LevelTag) => ({
        id: tag.id,
        name: tag.name,
        icon: tag.icon,
        color: tag.color,
        group: tag.group,
      })) || [],
  };
}
