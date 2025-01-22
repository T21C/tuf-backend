import Difficulty from "../../models/Difficulty";
import Level from "../../models/Level";
import Pass from "../../models/Pass";
import { MessageBuilder } from "../../webhook";
import { Score, calculateRankedScore } from "../../misc/PlayerStatsCalculator";
import { getVideoDetails } from "../../utils/videoDetailParser";

const ownUrlEnv = process.env.NODE_ENV === 'production' 
? process.env.PROD_API_URL 
: process.env.NODE_ENV === 'staging'
? process.env.STAGING_API_URL
: process.env.NODE_ENV === 'development'
? process.env.DEV_URL
: 'http://localhost:3002';

export async function getDifficultyEmojis(levelInfo: Level | null, rerate: boolean = false): Promise<string | null> {
    if (!levelInfo) return null;
    if (rerate && !levelInfo.dataValues.previousDiffId) rerate = false;
    const qList = "Q2,Q2+,Q3,Q3+,Q4";
    const qMap = {
      "Q2": ["U9", "U10"],
      "Q2+": ["U11", "U12"],
      "Q3": ["U13", "U14"],
      "Q3+": ["U15", "U16"],
      "Q4": ["U17", "U20"],
    }
    const difficulties = await Difficulty.findAll().then(data => data.map(difficulty => difficulty.dataValues));
    const level = levelInfo.dataValues;


    if (!rerate) {
    const difficulty = difficulties.find(difficulty => difficulty.name === level.difficulty?.name);
    if (qList.includes(level.difficulty?.name || '')) {
      const q = qMap[`${level.difficulty?.name || ''}` as keyof typeof qMap];
      const emoji = q.map(emoji => 
        difficulties.find(
          difficulty => difficulty.name === emoji
        )?.emoji || ''
      ).join('~')
      + ` | ${difficulties.find(
        difficulty => difficulty.name === q[0]
      )?.legacyEmoji || ''}`;
      return `${difficulty?.emoji || ''}||${emoji ? ` ${emoji}` : ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}||`;
    }
    return `${difficulty?.emoji || ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}`;
    }
    else {
      const difficulty = difficulties.find(difficulty => difficulty.name === level.difficulty?.name);
      const previousDifficulty = difficulties.find(difficulty => difficulty.name === level.previousDifficulty?.name);
      let diffString = '';
      let previousDiffString = '';
      if (qList.includes(level.difficulty?.name || '')) {
        const q = qMap[`${level.difficulty?.name || ''}` as keyof typeof qMap];
        const emoji = q.map(emoji => 
          difficulties.find(
            difficulty => difficulty.name === emoji
          )?.emoji || ''
        ).join('~')
        + ` | ${difficulties.find(
          difficulty => difficulty.name === q[0]
        )?.legacyEmoji || ''}`;
        diffString = `${difficulty?.emoji || ''}||${emoji ? ` ${emoji}` : ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}||`;
      }
      else {
        diffString = `${difficulty?.emoji || ''}${difficulty?.legacyEmoji ? ` | ${difficulty?.legacyEmoji}` : ''}`;
      }
      if (qList.includes(level.previousDifficulty?.name || '')) {
        const q = qMap[`${level.previousDifficulty?.name || ''}` as keyof typeof qMap];
        const emoji = q.map(emoji => 
          difficulties.find(
            difficulty => difficulty.name === emoji
          )?.emoji || ''
        ).join('~')
        + ` | ${difficulties.find(
          difficulty => difficulty.name === q[0]
        )?.legacyEmoji || ''}`;
        previousDiffString = `${previousDifficulty?.emoji || ''}||${emoji ? ` ${emoji}` : ''}${previousDifficulty?.legacyEmoji ? ` | ${previousDifficulty?.legacyEmoji}` : ''}||`;
      }
      else {
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
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  export function formatString(str: string): string {
    return str.replace(/\n/g, ' ');
  }




const placeHolder = ownUrlEnv + '/v2/media/image/soggycat.png';



export async function createRerateEmbed(levelInfo: Level | null): Promise<MessageBuilder> {
  if (!levelInfo) return new MessageBuilder().setDescription('No pass info available');
  const level = levelInfo.dataValues;
  const team = level?.team ? level?.team : null;
  const charter = level?.charter ? level?.charter : null;
  const creator = level?.creator ? level?.creator : null;
  const vfxer = level?.vfxer ? level?.vfxer : null;
  const videoInfo = await getVideoDetails(level.videoLink).then(details => details);

  const embed = new MessageBuilder()
      .setColor(level?.difficulty?.color || '#000000')
      //.setAuthor('New level!', '', '')
    .setTitle(`${wrap(level?.song || 'Unknown Song', 30)} — ${wrap(level?.artist || 'Unknown Artist', 30)}`)
    .setThumbnail(level.difficulty?.icon || placeHolder)
    .addField("", "", false)
    .addField('Rerate', `${await getDifficultyEmojis(levelInfo, true)}\n**${level.previousDifficulty?.baseScore || 0}**pp ➔ **${level.baseScore || level.difficulty?.baseScore || 0}**pp`, true)
    .addField("", "", false)
    
    if (team) embed
      .addField('', `Team\n**${formatString(team)}**`, true)
    if (vfxer) embed
      .addField('', `VFX\n**${formatString(vfxer)}**`, true);
    if (charter) embed
      .addField('', `Chart\n**${formatString(charter)}**`, true);
    else if (creator) embed
      .addField('', `Creator\n**${formatString(creator)}**`, true);
    
    embed.addField('', `**${level.videoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${level.videoLink})` : 'No video link'}**`, false)
    /*.setFooter(
      team || credit, 
      ''
    )*/
    //.setImage(videoInfo?.image || "")
    .setTimestamp();

  return embed;
}
  
  
  // DONE ############
  export async function createNewLevelEmbed(levelInfo: Level | null): Promise<MessageBuilder> {
    if (!levelInfo) return new MessageBuilder().setDescription('No level info available');
    const level = levelInfo.dataValues;
    const team = level?.team ? level?.team : null;
    const charter = level?.charter ? level?.charter : null;
    const creator = level?.creator ? level?.creator : null;
    const vfxer = level?.vfxer ? level?.vfxer : null;
    const comment = level?.publicComments ? level?.publicComments : "(Unspecified)";
    const videoInfo = await getVideoDetails(level.videoLink).then(details => details);

    const embed = new MessageBuilder()
        .setColor(level.difficulty?.color || '#000000')
        //.setAuthor('New level!', '', '')
      .setTitle(`${wrap(level?.song || 'Unknown Song', 30)} — ${wrap(level?.artist || 'Unknown Artist', 30)}`)
      .setThumbnail(level.difficulty?.icon || placeHolder)
      .addField("", "", false)
      .addField('Difficulty', `**${await getDifficultyEmojis(levelInfo)}**`, true)
      .addField("", "", false)
      if (comment && level.difficulty?.name == '-2') embed
        .addField('Reason', `**${formatString(comment)}**`, false)
      if (team) embed
        .addField('', `Team\n**${formatString(team)}**`, true)
      if (vfxer) embed
        .addField('', `VFX\n**${formatString(vfxer)}**`, true);
      if (charter) embed
        .addField('', `Chart\n**${formatString(charter)}**`, true);
      else if (creator) embed
        .addField('', `Creator\n**${formatString(creator)}**`, true);
      
      embed.addField('', `**${level.videoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${level.videoLink})` : 'No video link'}**`, false)
      /*.setFooter(
        team || credit, 
        ''
      )*/
      //.setImage(videoInfo?.image || "")
      .setTimestamp();
  
    return embed;
  }
  
  
  
// DONE ################
  export async function createClearEmbed(passInfo: Pass | null): Promise<MessageBuilder> {
    if (!passInfo) return new MessageBuilder().setDescription('No pass info available');
    const pass = passInfo.dataValues;
    const level = pass.level;

    const currentRankedScore = calculateRankedScore(pass.player?.passes?.map(pass => ({ 
        score: pass.scoreV2 || 0, 
        baseScore: pass.level?.baseScore || 0,
        xacc: pass.accuracy || 0,
        speed: pass.speed || 0,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false
    })) || []);

    const previousRankedScore = calculateRankedScore(pass.player?.passes?.filter(p => p.id !== pass.id).map(pass => ({ 
        score: pass.scoreV2 || 0, 
        baseScore: pass.level?.baseScore || 0,
        xacc: pass.accuracy || 0,
        speed: pass.speed || 0,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false
    })) || []);


    const videoInfo = pass?.videoLink ? await getVideoDetails(pass.videoLink).then(details => details) : null;

    const showAddInfo = pass.isWorldsFirst || pass.is12K || pass.is16K || pass.isNoHoldTap;
    const additionalInfo = (
    `${pass.isWorldsFirst ? '🏆 World\'s First!  |  ' : ''}` +
    `${pass.is12K ? '12K  |  ' : ''}` +
    `${pass.is16K ? '16K  |  ' : ''}` +
    `${pass.isNoHoldTap ? 'No Hold Tap  |  ' : ''}`
    ).replace(/\|\s*$/, '');
    const judgementLine = pass.judgements ? 
      `\`\`\`ansi\n[2;31m${pass.judgements.earlyDouble}[0m [2;33m${pass.judgements.earlySingle}[0m [2;32m${pass.judgements.ePerfect}[0m [1;32m${pass.judgements.perfect}[0m [2;32m${pass.judgements.lPerfect}[0m [2;33m${pass.judgements.lateSingle}[0m [2;31m${pass.judgements.lateDouble}[0m\n\`\`\`\n` : '';
    
      const team = level?.team ? `Level by ${level?.team}` : null;
      const credit = `Chart by ${trim(level?.charter || 'Unknown', 25)}${level?.vfxer ? ` | VFX by ${trim(level?.vfxer || 'Unknown', 25)}` : ''}`;

    const embed = new MessageBuilder()
      .setAuthor(
        `${trim(level?.song || 'Unknown Song', 27)}\n— ${trim(level?.artist || 'Unknown Artist', 30)}`,
        pass.level?.difficulty?.icon || '',
        level?.videoLink || ''
      )
      .setTitle(`Clear by ${trim(pass.player?.name || 'Unknown Player', 25)}`)
      .setColor(level?.difficulty?.color || '#000000')
      .setThumbnail(
        pass.player?.pfp && pass.player?.pfp !== "none" ?
        pass.player?.pfp :
        pass.player?.discordAvatar ?
        pass.player?.discordAvatar :
        placeHolder
      )
      .addField("", "", false)
      .addField('Player', `**${pass.player?.discordId ? `<@${pass.player?.discordId}>` : pass.player?.name || 'Unknown Player'}**`, true)
      .addField('Ranked Score', `**${formatNumber(currentRankedScore)}** (+${formatNumber(currentRankedScore - previousRankedScore)})`, true)
      .addField("", "", false)

      .addField('Feeling Rating', `**${pass.feelingRating || 'None'}**`, true)
      .addField('Score', `**${formatNumber(pass.scoreV2 || 0)}**`, true)
      .addField("", "", false)

      .addField('Accuracy', `**${((pass.accuracy || 0.95) * 100).toFixed(2)}%**`, true)
      .addField('<:1384060:1317995999355994112>', `**[Go to video](${pass.videoLink})**`, true)
      .addField("", "", false)
      .addField('', judgementLine, false)
      .addField(showAddInfo ? additionalInfo : '', '', false)
      .addField('', `**${pass.videoLink ? `[${videoInfo?.title || 'No title'}](${pass.videoLink})` : 'No video link'}**`, true)
      /*.setFooter(
        team || credit, 
        ''
      )*/
      .setImage(videoInfo?.image || "")
      .setFooter(
        team || credit, 
        ''
      )
      .setTimestamp();
    return embed;
  }