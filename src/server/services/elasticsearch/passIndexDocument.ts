import Pass from '@/models/passes/Pass.js';
import { convertToPUA } from '@/misc/utils/data/searchHelpers.js';
import { passPlayerAvatarProxyUrl } from '@/server/services/elasticsearch/sequelizeIncludes.js';

export function buildPassIndexDocument(pass: Pass): any {
  return {
    ...pass.get({ plain: true }),
    vidTitle: pass.vidTitle ? convertToPUA(pass.vidTitle) : null,
    videoLink: pass.videoLink ? convertToPUA(pass.videoLink) : null,
    player: pass.player
      ? {
          ...pass.player.get({ plain: true }),
          name: convertToPUA(pass.player.name),
          username: pass.player.user?.username,
          avatarUrl: passPlayerAvatarProxyUrl(pass.player.id),
        }
      : null,
    level: pass.level
      ? {
          ...pass.level.get({ plain: true }),
          song: convertToPUA(pass.level.song),
          artist: convertToPUA(pass.level.artist),
        }
      : null,
  };
}
