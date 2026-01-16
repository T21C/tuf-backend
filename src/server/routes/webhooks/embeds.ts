import Difficulty from '../../../models/levels/Difficulty.js';
import Level from '../../../models/levels/Level.js';
import Pass from '../../../models/passes/Pass.js';
import {MessageBuilder} from '../../../misc/webhook/index.js';
import {getVideoDetails} from '../../../misc/utils/data/videoDetailParser.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import { OAuthProvider } from '../../../models/index.js';
import { clientUrlEnv, ownUrl } from '../../../config/app.config.js';
import Rating from '../../../models/levels/Rating.js';

const playerStatsService = PlayerStatsService.getInstance();


export async function getDifficultyEmojis(
  levelInfo: Level | null,
  rating: Rating | null = null,
  rerate = false,
): Promise<string | null> {
  if (!levelInfo) return null;
  if (rerate && !levelInfo.dataValues.previousDiffId) rerate = false;

  const difficulties = await Difficulty.findAll().then(data =>
    data.map(difficulty => difficulty.dataValues),
  );
  const level = levelInfo.dataValues;

  const estimatedEmoji =
  rating?.averageDifficultyId ? difficulties.find(
    difficulty => difficulty.id === rating?.averageDifficultyId
  )?.emoji || '' : '';

  if (!rerate) {
    const difficulty = difficulties.find(
      difficulty => difficulty.name === level.difficulty?.name,
    );
    if (level.difficulty?.name.startsWith('Q')) {
      return `${difficulty?.emoji || ''} ${estimatedEmoji ? `||${estimatedEmoji}||` : ''}`;
    }
    return `${difficulty?.emoji || ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}`;
  } else {
    const difficulty = difficulties.find(
      difficulty => difficulty.name === level.difficulty?.name,
    );
    const previousDifficulty = difficulties.find(
      difficulty => difficulty.name === level.previousDifficulty?.name,
    );
    let diffString = '';
    let previousDiffString = '';
    if (level.difficulty?.name.startsWith('Q')) {
      const emoji = estimatedEmoji || '';
      diffString = `${difficulty?.emoji || ''}${emoji ? ` ||${emoji}||` : ''}`;
    } else {
      diffString = `${difficulty?.emoji || ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}`;
    }
    if (level.previousDifficulty?.name.startsWith('Q')) {
      previousDiffString = `${previousDifficulty?.emoji || ''}`;
    } else {
      previousDiffString = `${previousDifficulty?.emoji || ''}${previousDifficulty?.legacyEmoji ? ` | ${previousDifficulty?.legacyEmoji}` : ''}`;
    }
    return `**${previousDiffString}** ➔ **${diffString}**`;
  }
}

export function trim(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}
export function wrap(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;

  const chunks: string[] = [];
  let remaining = str;

  while (remaining.length > maxLength) {
    // Look for last space within maxLength
    let splitIndex = remaining.lastIndexOf(' ', maxLength);

    // If no space found or would result in very short chunk, just split at maxLength
    if (splitIndex === -1 || splitIndex < maxLength - 10) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.join('\n');
}
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US', {maximumFractionDigits: 2});
}
export function formatString(str: string): string {
  return str.replace(/\n/g, ' ');
}

const placeHolder = 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';

export async function createRerateEmbed(
  levelInfo: Level | null,
): Promise<MessageBuilder> {
  if (!levelInfo)
    return new MessageBuilder().setDescription('No pass info available');
  const level = levelInfo.dataValues;
  const team = level?.team ? level?.team : null;
  const charter = level?.charter ? level?.charter : null;
  const vfxer = level?.vfxer ? level?.vfxer : null;
  const videoInfo = await getVideoDetails(level.videoLink).then(
    details => details,
  );
  const comment = level?.publicComments
    ? level?.publicComments
    : '(Unspecified)';
  const rating = await Rating.findOne({
    where: {
      levelId: level.id,
    },
    order: [['confirmedAt', 'DESC']],
  });

  const embed = new MessageBuilder()
    .setColor(level?.difficulty?.color || '#000000')
    .setAuthor(
      `${wrap(level?.song || 'Unknown Song', 30)} — ${wrap(level?.artist || 'Unknown Artist', 30)}`,
      '',
      `${clientUrlEnv}/levels/${level.id}`,
    )
    .setTitle(`ID: ${level.id}`)
    .setThumbnail(level.difficulty?.icon || placeHolder)
    .addField('', '', false);

  const currentBaseScore = level.baseScore || level.difficulty?.baseScore || 0;
  const previousBaseScore = level.previousBaseScore || level.previousDifficulty?.baseScore || 0;
  // Check if this is a baseScore change without difficulty change
  const isBaseScoreChange = previousBaseScore !== currentBaseScore
                          && level.previousDiffId === level.diffId;

  if (isBaseScoreChange) {
    embed.addField(
      'Base Score Update',
      `**${previousBaseScore}**pp ➔ **${currentBaseScore}**pp`,
      true,
    );
  } else if (level.previousDiffId) {
    embed.addField(
      'Rerate',
      `${await getDifficultyEmojis(levelInfo, rating, true)}\n**${level.previousBaseScore || level.previousDifficulty?.baseScore || 0}**pp ➔ **${level.baseScore || level.difficulty?.baseScore || 0}**pp`,
      true,
    );
  }

  embed.addField('', '', false);

  if (team) embed.addField('', `Team\n**${formatString(team)}**`, true);
  if (vfxer) embed.addField('', `VFX\n**${formatString(vfxer)}**`, true);
  if (charter) embed.addField('', `Chart\n**${formatString(charter)}**`, true);
  if (comment && level.difficulty?.name === 'Censored')
    embed.addField('Reason', `**${formatString(comment)}**`, false);

  embed
    .addField(
      '',
      `**${level.videoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${level.videoLink})` : 'No video link'}**`,
      false,
    )
    .setFooter(`ID: ${level.id}`, '')
    .setTimestamp();

  return embed;
}

// DONE ############
export async function createNewLevelEmbed(
  levelInfo: Level | null,
): Promise<MessageBuilder> {
  if (!levelInfo)
    return new MessageBuilder().setDescription('No level info available');
  const level = levelInfo.dataValues;
  const team = level?.team ? level?.team : null;
  const charter = level?.charter ? level?.charter : null;
  const vfxer = level?.vfxer ? level?.vfxer : null;
  const comment = level?.publicComments
    ? level?.publicComments
    : '(Unspecified)';
  const videoInfo = await getVideoDetails(level.videoLink).then(
    details => details,
  );
  const rating = await Rating.findOne({
    where: {
      levelId: level.id,
    },
    order: [['confirmedAt', 'DESC']],
  });

  const embed = new MessageBuilder()
    .setColor(level.difficulty?.color || '#000000')
    .setAuthor(
      `${wrap(level?.song || 'Unknown Song', 30)} — ${wrap(level?.artist || 'Unknown Artist', 30)}`,
      '',
      `${clientUrlEnv}/levels/${level.id}`,
    )
    .setTitle(`ID: ${level.id}`)
    .setThumbnail(level.difficulty?.icon || placeHolder)
    .addField('', '', false)
    .addField('Difficulty', `**${await getDifficultyEmojis(levelInfo, rating)}**`, true)
    .addField('', '', false);
  if (comment && level.difficulty?.name === 'Censored')
    embed.addField('Reason', `**${formatString(comment)}**`, false);
  if (team) embed.addField('', `Team\n**${formatString(team)}**`, true);
  if (vfxer) embed.addField('', `VFX\n**${formatString(vfxer)}**`, true);
  if (charter) embed.addField('', `Chart\n**${formatString(charter)}**`, true);

  embed
    .addField(
      '',
      `**${level.videoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${level.videoLink})` : 'No video link'}**`,
      false,
    )
    .setFooter(`ID: ${level.id}`, '')
    //.setImage(videoInfo?.image || "")
    .setTimestamp();

  return embed;
}

// DONE ################
export async function createClearEmbed(
  pass: Pass | null,
): Promise<MessageBuilder> {
  if (!pass)
    return new MessageBuilder().setDescription('No pass info available');
  const level = pass.level;
  let discordProfile = null;
  if (pass.player?.user?.id) {
    discordProfile = await OAuthProvider.findOne({
      where: {
        userId: pass.player?.user?.id,
        provider: 'discord',
      },
    }).then(data => data?.profile);
  }
  const passDetails = await playerStatsService.getPassDetails(pass.id);

  const videoInfo = pass?.videoLink
    ? await getVideoDetails(pass.videoLink).then(details => details)
    : null;

  const showAddInfo =
    pass.isWorldsFirst || pass.is12K || pass.is16K || pass.isNoHoldTap;
  const additionalInfo = (
    `${pass.isWorldsFirst ? "🏆 World's First!  |  " : ''}` +
    `${pass.is12K ? '12K  |  ' : ''}` +
    `${pass.is16K ? '16K  |  ' : ''}` +
    `${pass.isNoHoldTap ? 'No Hold Tap  |  ' : ''}`
  ).replace(/\|\s*$/, '');
  const judgementLine = pass.judgements
    ? `\`\`\`ansi\n[2;31m${pass.judgements.earlyDouble}[0m [2;33m${pass.judgements.earlySingle}[0m [2;32m${pass.judgements.ePerfect}[0m [1;32m${pass.judgements.perfect}[0m [2;32m${pass.judgements.lPerfect}[0m [2;33m${pass.judgements.lateSingle}[0m [2;31m${pass.judgements.lateDouble}[0m\n\`\`\`\n`
    : '';

  const team = level?.team ? `Level by ${level?.team}` : null;
  const credit = `Chart by ${trim(level?.charter || 'Unknown', 25)}${level?.vfxer ? ` | VFX by ${trim(level?.vfxer || 'Unknown', 25)}` : ''}`;

  const embed = new MessageBuilder()
    .setAuthor(
      `${trim(level?.song || 'Unknown Song', 27)}${pass.speed !== 1 ? ` (${pass.speed}x)` : ''}\n— ${trim(level?.artist || 'Unknown Artist', 30)}`,
      pass.level?.difficulty?.icon || '',
      `${clientUrlEnv}/passes/${pass.id}`,
    )
    .setTitle(`Clear by ${trim(pass.player?.name || 'Unknown Player', 25)}`)
    .setColor(level?.difficulty?.color || '#000000')
    .setThumbnail(
      pass.player?.user?.avatarUrl
        ? pass.player?.user?.avatarUrl
          : pass.player?.pfp && pass.player?.pfp !== 'none'
          ? pass.player?.pfp
          : placeHolder,
    )
    .addField('', '', false)
    .addField(
      'Player',
      `**${discordProfile ? `<@${(discordProfile as any)?.id}>` : pass.player?.name || 'Unknown Player'}**`,
      true,
    )
    .addField(
      'Ranked Score',
      `**${
        formatNumber(passDetails?.scoreInfo?.currentRankedScore || 0)
      }** (+${
        formatNumber(passDetails?.scoreInfo?.impact || 0)
        })`,
      true,
    )
    .addField('', '', false)

    .addField('Feeling Rating', `**${pass.feelingRating || 'None'}**`, true)
    .addField('Score', `**${formatNumber(pass.scoreV2 || 0)}**`, true)
    .addField('', '', false)

    .addField(
      'Accuracy',
      `**${((pass.accuracy || pass.judgements?.accuracy || 0.95) * 100).toFixed(2)}%**`,
      true,
    )
    .addField(
      `${pass.videoLink?.includes('bilibili') || pass.videoLink?.includes('b32.tv') ? '<:icons8bilibili48:1334853728905330738>' : '<:1384060:1317995999355994112>'}`,
      `**[Go to video](${pass.videoLink})**`,
      true,
    )
    .addField('', '', false)
    .addField('', judgementLine, false)
    .addField(showAddInfo ? additionalInfo : '', '', false)
    .addField(
      '',
      `**${pass.videoLink ? `[${videoInfo?.title || 'No title'}](${pass.videoLink})` : 'No video link'}**`,
      true,
    )
    /*.setFooter(
        team || credit,
        ''
      )*/
    .setImage(videoInfo?.image || '')
    .setFooter(`${team || credit} | ID: ${level?.id}`, '')
    .setTimestamp();
  return embed;
}
