import CurationType from '@/models/curations/CurationType.js';
import Difficulty from '@/models/levels/Difficulty.js';
import type Level from '@/models/levels/Level.js';
import {MessageBuilder} from '@/misc/webhook/index.js';
import {clientUrlEnv} from '@/config/app.config.js';
import {curationTypeEmojiMarkup} from '@/misc/utils/data/curationTypeEmojis.js';
import {getSongDisplayName} from '@/misc/utils/data/levelHelpers.js';
import {isSilentCurationAnnouncementName} from '@/misc/utils/data/curationTypeFamilies.js';
import {formatCreatorDisplay} from '@/misc/utils/Utility.js';
import {toAbsoluteAssetUrl} from '@/server/services/notifications/pushArtwork.js';

function asIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number(item)).filter((id) => Number.isInteger(id) && id > 0))];
}

async function typeLine(typeIds: number[]): Promise<string> {
  const ids = asIdList(typeIds);
  if (ids.length === 0) return '—';
  const rows = await CurationType.findAll({
    where: {id: ids},
    attributes: ['id', 'name'],
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visible = ids.filter((id) => {
    const name = byId.get(id)?.name;
    return !isSilentCurationAnnouncementName(name);
  });
  if (visible.length === 0) return '—';
  return visible
    .map((id) => {
      const name = byId.get(id)?.name || `#${id}`;
      return curationTypeEmojiMarkup(name) || name;
    })
    .join(' ');
}

async function difficultyAuthorIcon(level: Level): Promise<string> {
  const loaded = level.difficulty?.icon;
  if (loaded) return toAbsoluteAssetUrl(loaded) || '';
  if (!level.diffId) return '';
  const row = await Difficulty.findByPk(level.diffId, {attributes: ['icon']});
  return toAbsoluteAssetUrl(row?.icon) || '';
}

export async function createCurationAnnouncementEmbed(input: {
  level: Level;
  kind: 'NEW' | 'RERATE';
  beforeTypeIds: number[];
  afterTypeIds: number[];
}): Promise<MessageBuilder> {
  const level = input.level;
  const song = getSongDisplayName(level) || level.song || 'Unknown Song';
  const url = `${String(clientUrlEnv || '').replace(/\/$/, '')}/levels/${level.id}`;
  const afterLine = await typeLine(input.afterTypeIds);
  const embed = new MessageBuilder()
    .setColor('#6f42c1')
    .setAuthor(`${song} — ${level.artist || 'Unknown Artist'}`, await difficultyAuthorIcon(level), url)
    .setTimestamp();

  if (input.kind === 'RERATE') {
    const beforeLine = await typeLine(input.beforeTypeIds);
    embed.addField('Previous', beforeLine, false);
    embed.addField('New', afterLine, false);
  } else {
    embed.setDescription(afterLine);
  }

  embed.setFooter(formatCreatorDisplay(level), '');
  return embed;
}
