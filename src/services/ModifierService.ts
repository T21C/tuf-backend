import PlayerModifier, { ModifierType } from '../models/PlayerModifier.js';
import { Op } from 'sequelize';
import { PlayerStatsService } from './PlayerStatsService.js';
import Pass from '../models/Pass.js';
import Level from '../models/Level.js';
import { CronJob } from 'cron';
import Player from '../models/Player.js';
import User from '../models/User.js';
import Judgement from '../models/Judgement.js';
import sequelize from '../config/db.js';
import PlayerStats from '../models/PlayerStats.js';
import Difficulty from '../models/Difficulty.js';
import { calcAcc } from '../misc/CalcAcc.js';
import { getScoreV2 } from '../misc/CalcScore.js';

export class ModifierService {
  private static instance: ModifierService;
  private modifiersEnabled: boolean = true;
  private cooldownSet = new Set<string>();
  private readonly COOLDOWN_MS = 15 * 1000; // 15 seconds
  
  // Custom expiration times in hours for each modifier type
  private readonly EXPIRATION_TIMES: Record<ModifierType, number> = {
    [ModifierType.RANKED_ADD]: 2,
    [ModifierType.RANKED_MULTIPLY]: 2,
    [ModifierType.SCORE_FLIP]: 2,
    [ModifierType.SCORE_COMBINE]: 2,
    [ModifierType.KING_OF_CASTLE]: 1, // 24 hours for KOC
    [ModifierType.BAN_HAMMER]: 0.5, // 1 hour for ban hammer
    [ModifierType.SUPER_ADMIN]: 0.083, // 5 minutes for super admin
    [ModifierType.PLAYER_SWAP]: 1,
    [ModifierType.OOPS_ALL_MISS]: 2
  };

  private constructor() {
    // Initialize cron job to check for expired modifiers every minute
    new CronJob('* * * * *', this.checkExpiredModifiers.bind(this)).start();
  }

  public static getInstance(): ModifierService {
    if (!ModifierService.instance) {
      ModifierService.instance = new ModifierService();
    }
    return ModifierService.instance;
  }

  public setModifiersEnabled(enabled: boolean): void {
    this.modifiersEnabled = enabled;
  }

  public isModifiersEnabled(): boolean {
    return this.modifiersEnabled;
  }

  public async getActiveModifiers(playerId: number): Promise<PlayerModifier[]> {
    return await PlayerModifier.findAll({
      where: {
        playerId,
        expiresAt: {
          [Op.gt]: new Date()
        }
      }
    });
  }

  private getExpirationTime(type: ModifierType): Date {
    const hours = this.EXPIRATION_TIMES[type] || 2; // Default to 2 hours if not specified
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + hours);
    return expiresAt;
  }

  public async addModifier(playerId: number, type: ModifierType, value: number | null = null): Promise<PlayerModifier> {
    // Check if this is a non-stackable modifier
    const isNonStackable = [
      ModifierType.KING_OF_CASTLE,
      ModifierType.BAN_HAMMER,
      ModifierType.SUPER_ADMIN,
      ModifierType.PLAYER_SWAP
    ].includes(type);


    if (isNonStackable) {
      // Find existing non-expired modifier of the same type
      const existingModifier = await PlayerModifier.findOne({
        where: {
          playerId,
          type,
        }
      });

      if (existingModifier) {
        // Extend the expiration time using the custom duration
        const newExpiresAt = this.getExpirationTime(type);
        
        if (type !== ModifierType.PLAYER_SWAP) {
        await existingModifier.update({
          expiresAt: newExpiresAt,
          value // Update value in case it changed
        });
        }
        else {
          await existingModifier.update({
            expiresAt: newExpiresAt,
          });
        }

        console.log(`[ModifierService] Extended expiration for non-stackable modifier ${type} for player ${playerId} until ${newExpiresAt.toISOString()}`);
        return existingModifier;
      }
    }

    // For stackable modifiers or if no existing non-stackable modifier found
    const expiresAt = this.getExpirationTime(type);

    const modifier = await PlayerModifier.create({
      playerId,
      type,
      value,
      expiresAt
    });

    console.log(`[ModifierService] Created new modifier ${type} for player ${playerId} until ${expiresAt.toISOString()}`);
    return modifier;
  }

  private async checkExpiredModifiers() {
    try {
      const expiredModifiers = await PlayerModifier.findAll({
        where: {
          expiresAt: {
            [Op.lte]: new Date()
          }
        }
      });

      if (expiredModifiers.length === 0) {
        return;
      }

      console.log(`[ModifierService] Found ${expiredModifiers.length} expired modifiers to process`);

      for (const modifier of expiredModifiers) {
        try {
          console.log(`[ModifierService] Processing expired modifier ${modifier.type} for player ${modifier.playerId}`);
          
          switch (modifier.type) {
            case ModifierType.KING_OF_CASTLE:
              await this.handleKingOfCastle(modifier.playerId, false);
              break;
            case ModifierType.BAN_HAMMER:
              await this.handleBanHammer(modifier.playerId, false);
              break;
            case ModifierType.SUPER_ADMIN:
              await this.handleSuperAdmin(modifier.playerId, false);
              break;
            case ModifierType.OOPS_ALL_MISS:
              await this.handleOopsAllMiss(modifier.playerId, false);
              break;
            case ModifierType.PLAYER_SWAP:
              // For player swap, we use the stored target player ID directly
              if (modifier.value) {
                const targetPlayerId = Number(modifier.value);
                if (!isNaN(targetPlayerId)) {
                  console.log(`[Player Swap] Reverting swap between player ${modifier.playerId} and ${targetPlayerId}`);
                  await this.handlePlayerSwap(modifier.playerId, true);
                }
              }
              break;
          }

          await modifier.destroy();
          console.log(`[ModifierService] Successfully processed and removed expired modifier ${modifier.type} for player ${modifier.playerId}`);
        } catch (error) {
          console.error(`[ModifierService] Error processing expired modifier ${modifier.type} for player ${modifier.playerId}:`, error);
        }
      }
    } catch (error) {
      console.error('[ModifierService] Error checking expired modifiers:', error);
    }
  }

  private async recalculateLevelClearCount(levelId: number): Promise<void> {
    try {
      const clearCount = await Pass.count({
        where: {
          levelId,
          isDeleted: false,
          isHidden: false
        }
      });

      await Level.update(
        { clears: clearCount },
        {
          where: { id: levelId }
        }
      );
    } catch (error) {
      console.error('Error recalculating level clear count:', error);
    }
  }

  public async handleKingOfCastle(playerId: number, hide: boolean = true): Promise<void> {
    try {
      console.log(`[KOC] Starting KOC handler for player ${playerId}, hide: ${hide}`);
      
      // Get all passes where the player has WF
      const wfPasses = await Pass.findAll({
        where: {
          playerId,
          isWorldsFirst: true,
          isDeleted: false
        }
      });

      console.log(`[KOC] Found ${wfPasses.length} WF passes for player ${playerId}`);
      
      for (const wfPass of wfPasses) {
        console.log(`[KOC] Processing level ${wfPass.levelId}`);
        
        // Find all other passes for this level
        const otherPasses = await Pass.findAll({
          where: {
            levelId: wfPass.levelId,
            isWorldsFirst: false,
            isDeleted: false
          }
        });

        console.log(`[KOC] Found ${otherPasses.length} other passes for level ${wfPass.levelId}`);

        // Hide all other passes
        await Pass.update(
          { isHidden: hide },
          {
            where: {
              id: {
                [Op.in]: otherPasses.map(pass => pass.id)
              }
            }
          }
        );

        // Set clear count to 1 for this level (only showing the king's pass)
        if (hide) {
          await Level.update(
            { clears: 1 },
            {
              where: { id: wfPass.levelId }
            }
          );
          console.log(`[KOC] Set clear count to 1 for level ${wfPass.levelId}`);
        } else {
          await this.recalculateLevelClearCount(wfPass.levelId);
          console.log(`[KOC] Recalculated clear count for level ${wfPass.levelId}`);
        }
      }
      
      console.log(`[KOC] Completed KOC handler for player ${playerId}`);
    } catch (error) {
      console.error(`[KOC] Error handling kingofcastle for player ${playerId}:`, error);
    }
  }

  public async handleBanHammer(playerId: number, ban: boolean = true): Promise<void> {
    // TODO: Implement ban hammer handling
    const player = await Player.findByPk(playerId);
    if (!player) {
      console.error(`[Ban Hammer] Player ${playerId} not found`);
      return;
    }
    player.update({
      isBanned: ban
    });

    console.log(`[Ban Hammer] Handling ban hammer for player ${playerId}, ban: ${ban}`);
  }

  public async handleSuperAdmin(playerId: number, enable: boolean = true): Promise<void> {
    const user = await User.findOne({
      where: {
        playerId: playerId
      }
    });
    if (!user) {
      console.error(`[Super Admin] Player ${playerId} not found`);
      return;
    }
    user.update({
      isSuperAdmin: enable
    });
    console.log(`[Super Admin] Handling super admin for player ${playerId}, enable: ${enable}`);
  }

  public async handleOopsAllMiss(playerId: number, undo: boolean = false): Promise<void> {   
    try {
      console.log(`[Oops All Miss] Starting handler for player ${playerId}, undo: ${undo}`);
      
      const passes = await Pass.findAll({
        where: {
          playerId: playerId,
          isDeleted: false
        },
        include: [{
          model: Judgement,
          as: 'judgements'
        }]
      });

      if (!passes || passes.length === 0) {
        console.error(`[Oops All Miss] No passes found for player ${playerId}`);
        return;
      }

      console.log(`[Oops All Miss] Found ${passes.length} passes to process`);

      const transaction = await sequelize.transaction();
      try {
        for (const pass of passes) {
          if (pass.judgements) {
            const currentEarlyDouble = pass.judgements.earlyDouble || 0;
            const newEarlyDouble = currentEarlyDouble + (undo ? -25 : 25);
            await pass.judgements.update({
                ...pass.judgements,
                earlyDouble: newEarlyDouble > 0 ? newEarlyDouble : 0
              }, { transaction });
            console.log(`[Oops All Miss] Added ${undo ? -25 : 25} early doubles to pass ${pass.id}, new total: ${currentEarlyDouble + (undo ? -25 : 25)}`);

            // Get level data for score recalculation
            const level = await Level.findByPk(pass.levelId, {
              include: [{
                model: Difficulty,
                as: 'difficulty'
              }],
              transaction
            });

            if (level) {
              // Recalculate accuracy
              const newAccuracy = calcAcc(pass.judgements);
              
              // Recalculate score
              const newScore = getScoreV2(
                {
                  speed: pass.speed || 1,
                  judgements: {
                    earlyDouble: pass.judgements.earlyDouble || 0,
                    earlySingle: pass.judgements.earlySingle || 0,
                    ePerfect: pass.judgements.ePerfect || 0,
                    perfect: pass.judgements.perfect || 0,
                    lPerfect: pass.judgements.lPerfect || 0,
                    lateSingle: pass.judgements.lateSingle || 0,
                    lateDouble: pass.judgements.lateDouble || 0,
                  },
                  isNoHoldTap: pass.isNoHoldTap || false 
                },
                {
                  baseScore: level.baseScore || 0,
                  difficulty: level.difficulty || { baseScore: 0 }
                }
              );

              // Update pass with new values
              await pass.update({
                accuracy: newAccuracy,
                scoreV2: newScore
              }, { transaction });

              console.log(`[Oops All Miss] Updated pass ${pass.id} with new accuracy: ${newAccuracy} and score: ${newScore}`);
            }
          }
        }

        await transaction.commit();
        console.log(`[Oops All Miss] Completed processing for player ${playerId}`);

        // Update player stats after all passes are processed
        await PlayerStatsService.getInstance().updatePlayerStats(playerId);
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    } catch (error) {
      console.error(`[Oops All Miss] Error processing for player ${playerId}:`, error);
      throw error;
    }
  }

  public async applyModifier(modifier: PlayerModifier): Promise<void> {
    if (!this.modifiersEnabled) return;
    const playerId = modifier.playerId;
    try {
      console.log(`[ModifierService] Applying modifier ${modifier.type} for player ${playerId}`);
      
      switch (modifier.type) {
        case ModifierType.KING_OF_CASTLE:
          await this.handleKingOfCastle(playerId, true);
          break;
        case ModifierType.BAN_HAMMER:
          await this.handleBanHammer(playerId);
          break;
        case ModifierType.SUPER_ADMIN:
          await this.handleSuperAdmin(playerId);
          break;
        case ModifierType.OOPS_ALL_MISS:
          await this.handleOopsAllMiss(playerId);
          break;
        case ModifierType.PLAYER_SWAP:
          await this.handlePlayerSwap(playerId);
          break;
      }
      
      console.log(`[ModifierService] Successfully applied modifier ${modifier.type} for player ${playerId}`);
    } catch (error) {
      console.error(`[ModifierService] Error applying modifier ${modifier.type} for player ${playerId}:`, error);
      throw error;
    }
  }

  public async applyAllModifiers(playerId: number): Promise<void> {
    if (!this.modifiersEnabled) return;
    
    try {
      const activeModifiers = await this.getActiveModifiers(playerId);
      console.log(`[ModifierService] Applying ${activeModifiers.length} active modifiers for player ${playerId}`);

      for (const modifier of activeModifiers) {
        try {
          await this.applyModifier(modifier);
        } catch (error) {
          console.error(`[ModifierService] Error processing modifier ${modifier.type} for player ${playerId}:`, error);
        }
      }
    } catch (error) {
      console.error(`[ModifierService] Error applying modifiers for player ${playerId}:`, error);
    }
  }

  public async applyScoreModifiers(playerId: number, stats: any): Promise<any> {
    if (!this.modifiersEnabled) return stats;
    
    const activeModifiers = await this.getActiveModifiers(playerId);
    let modifiedStats = { ...stats };

    for (const modifier of activeModifiers) {
      switch (modifier.type) {
        case ModifierType.RANKED_ADD:
          modifiedStats.rankedScore += modifier.value || 0;
          break;
        case ModifierType.RANKED_MULTIPLY:
          modifiedStats.rankedScore *= modifier.value || 1;
          break;
        case ModifierType.SCORE_FLIP:
          modifiedStats.rankedScore = this.flipScore(modifiedStats.rankedScore);
          break;
        case ModifierType.SCORE_COMBINE:
          modifiedStats.rankedScore = this.combineScores(
            modifiedStats.rankedScore,
            modifiedStats.generalScore,
            modifiedStats.ppScore,
            modifiedStats.wfScore,
            modifiedStats.score12K
          );
          break;
      }
    }

    // Ensure all scores are floored
    modifiedStats.rankedScore = Math.floor(modifiedStats.rankedScore);
    modifiedStats.generalScore = Math.floor(modifiedStats.generalScore);
    modifiedStats.ppScore = Math.floor(modifiedStats.ppScore);
    modifiedStats.wfScore = Math.floor(modifiedStats.wfScore);
    modifiedStats.score12K = Math.floor(modifiedStats.score12K);

    return modifiedStats;
  }

  private async getRandomNonBannedPlayerId(excludePlayerId: number): Promise<number | null> {
    try {
      const randomPlayer = await Player.findOne({
        where: {
          id: {
            [Op.ne]: excludePlayerId
          },
          isBanned: false
        },
        order: [sequelize.random()]
      });

      console.log(`[Player Swap] Random player: ${randomPlayer?.id}`);
      return randomPlayer?.id || null;
    } catch (error) {
      console.error('[Player Swap] Error getting random player:', error);
      return null;
    }
  }

  public async handlePlayerSwap(playerId: number, undo: boolean = false): Promise<void> {
    let targetPlayerId = await this.getRandomNonBannedPlayerId(playerId);
    if (!targetPlayerId) {
      console.error(`[Player Swap] No valid target found for player ${playerId}`);
      return;
    }
    try {
        let swap = null;
    
        swap = await PlayerModifier.findOne({
          where: {
            playerId: playerId,
            type: ModifierType.PLAYER_SWAP,
            expiresAt:  !undo ?{
              [Op.gt]: new Date()
            } : {
              [Op.not]: null
            }
          }
        })
        console.log(`[Player Swap] Found swap: ${swap}`);
        if (swap?.value && !undo) {
          console.log(`[Player Swap] Found existing swap for player ${playerId}, ignoring...`);
          return;
        }
        targetPlayerId = undo && swap?.value ? swap?.value : targetPlayerId;

      console.log(`[Player Swap] Starting ${undo ? 'undo' : 'swap'} process for player ${playerId} with target ${targetPlayerId}`);
      

      // Get both players
      console.log(`[Player Swap] Fetching player data for ${playerId} and ${targetPlayerId}`);
      const player = await Player.findByPk(playerId);
      const targetPlayer = await Player.findByPk(targetPlayerId);
      
      if (!player || !targetPlayer) {
        console.error(`[Player Swap] Player lookup failed - Player ${playerId}: ${!!player}, Target ${targetPlayerId}: ${!!targetPlayer}`);
        return;
      }
      console.log(`[Player Swap] Found players: ${player.name} (${playerId}) and ${targetPlayer.name} (${targetPlayerId})`);


      // For undo, we don't need to check for existing swaps
      if (!undo) {
        // Check if either player is already in a swap
        console.log(`[Player Swap] Creating new swap...`);


        swap = await PlayerModifier.update({
          value: targetPlayerId,
          expiresAt: this.getExpirationTime(ModifierType.PLAYER_SWAP)
        }, {
          where: {
            playerId: playerId,
            type: ModifierType.PLAYER_SWAP,
            expiresAt: {
              [Op.gt]: new Date()
            }
          }
        });

        if (!swap) {
          console.error(`[Player Swap] Failed to create swap`);
          return;
        }
        console.log(`[Player Swap] No existing swaps found, proceeding with swap`);
      }


      // Swap the player IDs in passes
      const transaction = await sequelize.transaction();
      console.log(`[Player Swap] Starting pass swap transaction...`);
      try {
        console.log(`[Player Swap] Fetching passes for both players...`);
        const playerPasses = await Pass.findAll({
          where: { 
            playerId: undo ? targetPlayerId : playerId,
            isDeleted: false
          },
          transaction
        });

        const targetPasses = await Pass.findAll({
          where: { 
            playerId: undo ? playerId : targetPlayerId,
            isDeleted: false
          },
          transaction
        });

        console.log(`[Player Swap] Pass counts - ${player.name}: ${playerPasses.length}, ${targetPlayer.name}: ${targetPasses.length}`);

        // Update all passes for player 1
        console.log(`[Player Swap] Updating passes for ${player.name}...`);
        const playerUpdateResult = await Pass.update(
          { playerId: undo ? playerId : targetPlayerId },
          {
            where: { 
              id: {
                [Op.in]: playerPasses.map(pass => pass.id)
              }
            },
            transaction
          }
        );
        console.log(`[Player Swap] Updated ${playerUpdateResult[0]} passes for ${player.name}`);

        // Update all passes for player 2
        console.log(`[Player Swap] Updating passes for ${targetPlayer.name}...`);
        const targetUpdateResult = await Pass.update(
          { playerId: undo ? targetPlayerId : playerId },
          {
            where: { 
              id: {
                [Op.in]: targetPasses.map(pass => pass.id)
              }
            },
            transaction
          }
        );
        console.log(`[Player Swap] Updated ${targetUpdateResult[0]} passes for ${targetPlayer.name}`);

        await transaction.commit();
        console.log(`[Player Swap] Transaction completed successfully`);

        console.log(`[Player Swap] ${undo ? 'Undo' : 'Swap'} completed successfully between ${player.name} and ${targetPlayer.name}`);
        console.log(`[Player Swap] Total passes ${undo ? 'restored' : 'swapped'}: ${playerPasses.length + targetPasses.length}`);
      } catch (error) {
        await transaction.rollback();
        console.error(`[Player Swap] Transaction failed, rolling back:`, error);
        throw error;
      }
    } catch (error) {
      console.error(`[Player Swap] Error during ${undo ? 'undo' : 'swap'} process:`, error);
      throw error;
    }
  }

  public async generateModifier(playerId: number): Promise<PlayerModifier | null> {
    const roll = Math.random() * 100;
    let cumulativeProbability = 0;

    for (const [type, probability] of Object.entries(PlayerModifier.PROBABILITIES)) {
      cumulativeProbability += probability;
      
      if (roll <= cumulativeProbability) {
        let value = null;
        return await this.addModifier(playerId, type as ModifierType, value);
      }
    }

    return null;
  }

  private flipScore(score: number): number {
    // Convert to string and handle decimals
    const scoreStr = score.toFixed(2);
    
    // Split into integer and decimal parts
    const [intPart, decPart] = scoreStr.split('.');
    
    // Flip the integer part
    const flippedInt = intPart.split('').reverse().join('');
    
    // Combine back with decimal part
    return parseFloat(`${flippedInt}.${decPart}`);
  }

  private combineScores(
    rankedScore: number,
    generalScore: number,
    ppScore: number,
    wfScore: number,
    score12K: number
  ): number {
    // Convert all scores to integers and sum them
    return Math.floor(rankedScore) + 
           Math.floor(generalScore) + 
           Math.floor(ppScore) + 
           Math.floor(wfScore) + 
           Math.floor(score12K);
  }

  private getCooldownKey(playerId: number, targetPlayerId: number): string {
    return `${playerId}:${targetPlayerId}`;
  }

  private isOnCooldown(playerId: number, targetPlayerId: number): boolean {
    const key = this.getCooldownKey(playerId, targetPlayerId);
    return this.cooldownSet.has(key);
  }

  private addCooldown(playerId: number, targetPlayerId: number): void {
    const key = this.getCooldownKey(playerId, targetPlayerId);
    this.cooldownSet.add(key);
    
    // Remove the cooldown after the timeout
    setTimeout(() => {
      this.cooldownSet.delete(key);
    }, this.COOLDOWN_MS);
  }

  public getRemainingCooldown(playerId: number, targetPlayerId: number): number {
    return this.isOnCooldown(playerId, targetPlayerId) ? this.COOLDOWN_MS : 0;
  }

  public async handleModifierGeneration(playerId: number, targetPlayerId: number): Promise<{ modifier: PlayerModifier | null; error?: string }> {
    try {
      // Check if target player exists
      const targetPlayer = await Player.findByPk(targetPlayerId);
      if (!targetPlayer) {
        return { modifier: null, error: 'Target player not found' };
      }

      // Check cooldown
      if (this.isOnCooldown(playerId, targetPlayerId)) {
        const remainingTime = Math.ceil(this.getRemainingCooldown(playerId, targetPlayerId) / 1000);
        return { 
          modifier: null, 
          error: `Spin cooldown active (${remainingTime}s remaining)` 
        };
      }

      // Generate the modifier
      const modifier = await this.generateModifier(targetPlayerId);
      if (!modifier) {
        return { modifier: null, error: 'No modifier was generated' };
      }

      // Handle special cases
      if (modifier.type === ModifierType.BAN_HAMMER) {
        // For ban hammer, always apply to the roller
        const banModifier = await this.addModifier(
          playerId,
          modifier.type,
          modifier.value
        );
        
        // Update player stats
        await PlayerStatsService.getInstance().updatePlayerStats(playerId);
        
        // Add cooldown
        this.addCooldown(playerId, targetPlayerId);
        
        return { modifier: banModifier };
      }

      // Add cooldown
      this.addCooldown(playerId, targetPlayerId);

      return { modifier };
    } catch (error) {
      console.error('Error handling modifier generation:', error);
      return { modifier: null, error: 'Failed to generate modifier' };
    }
  }
}
