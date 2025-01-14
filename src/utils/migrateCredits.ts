import Level from '../models/Level';
import Creator from '../models/Creator';
import Team from '../models/Team';
import TeamMember from '../models/TeamMember';
import LevelCredit from '../models/LevelCredit';
import { parseCredits } from './creditParser';
import { Transaction } from 'sequelize';
import { ILevel } from '../interfaces/models';

export async function migrateCredits(levels: Omit<ILevel, 'submitterDiscordId' | 'createdAt' | 'updatedAt'>[], transaction: Transaction): Promise<void> {
  console.log('Starting credit migration...');
  
  // First, collect all unique creator names and team names
  const uniqueCreatorNames = new Set<string>();
  const uniqueTeamNames = new Set<string>();
  const creditEntries: { levelId: number; creatorName: string; role: string }[] = [];
  const teamEntries: { levelId: number; teamName: string; creatorName: string }[] = [];

  const logCreatorDebug = (context: string, name: string, data: any = {}) => {
    if (name === 'RedCRP' || name === 'PLORALD (and Jofo)') {
      console.log(`\n🔍 ${name} Debug - ${context}:`, {
        ...data,
        timestamp: new Date().toISOString()
      });
    }
  };

  // Process all levels first to gather data
  for (const level of levels) {
    const credits = parseCredits(level.creator, level.charter, level.vfxer);
    
    // Add all creators to the unique set
    credits.charters.forEach(name => {
      uniqueCreatorNames.add(name);
      logCreatorDebug('Added to uniqueCreatorNames', name, { level: level.id });
    });
    credits.vfxers.forEach(name => {
      uniqueCreatorNames.add(name);
      logCreatorDebug('Added to uniqueCreatorNames', name, { level: level.id });
    });

    // Store credit relationships and team assignments
    if (credits.team && level.team && level.team.trim() !== '') {
      uniqueTeamNames.add(credits.team);
      
      credits.charters.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'charter' });
        teamEntries.push({ levelId: level.id, teamName: credits.team!, creatorName: name });
        logCreatorDebug('Added charter credit with team', name, { 
          level: level.id, 
          team: credits.team,
          creditEntries: creditEntries.filter(e => e.creatorName === name)
        });
      });

      credits.vfxers.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'vfxer' });
        teamEntries.push({ levelId: level.id, teamName: credits.team!, creatorName: name });
        logCreatorDebug('Added vfxer credit with team', name, { 
          level: level.id, 
          team: credits.team,
          creditEntries: creditEntries.filter(e => e.creatorName === name)
        });
      });

      if (!level.creator.includes('[') && !level.creator.includes('(') && 
          !level.charter.includes('[') && !level.charter.includes('(') &&
          !level.vfxer.includes('[') && !level.vfxer.includes('(')) {
        await Level.update({ isVerified: true }, { where: { id: level.id }, transaction });
      }
    } else {
      credits.charters.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'charter' });
        logCreatorDebug('Added charter credit without team', name, { 
          level: level.id,
          creditEntries: creditEntries.filter(e => e.creatorName === name)
        });
      });
      credits.vfxers.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'vfxer' });
        logCreatorDebug('Added vfxer credit without team', name, { 
          level: level.id,
          creditEntries: creditEntries.filter(e => e.creatorName === name)
        });
      });
    }
  }

  // Get existing creators and teams
  const existingCreators = await Creator.findAll({
    where: { name: Array.from(uniqueCreatorNames) },
    transaction
  });

  // Create a map of existing creators by name for validation
  const existingCreatorsByName = new Map(existingCreators.map(c => [c.name, c]));

  // Prepare initial creator records
  let creatorsToCreate = Array.from(uniqueCreatorNames)
    .filter(name => !existingCreatorsByName.has(name))
    .map(name => {
      logCreatorDebug('Preparing to create creator record', name);
      const now = new Date();
      return {
        name,
        aliases: [] as string[],
        createdAt: now,
        updatedAt: now
      };
    });

  // Clean up duplicates right before creation
  const finalCreators = [];
  const usedNames = new Set(existingCreators.map(c => c.name));
  const nameMap = new Map(); // Map original names to final names

  for (const creator of creatorsToCreate) {
    let finalName = creator.name;
    while (usedNames.has(finalName)) {
      finalName = `${finalName} (DUPLICATE)`;
    }
    usedNames.add(finalName);
    
    if (finalName !== creator.name) {
      nameMap.set(creator.name, finalName);
      creator.aliases = [creator.name] as string[];
      logCreatorDebug('Renamed duplicate creator', creator.name, {
        newName: finalName,
        originalName: creator.name
      });
    }
    creator.name = finalName;
    finalCreators.push(creator);
  }

  // Bulk create new creators with strict validation
  const creators = await Creator.bulkCreate(
    finalCreators,
    {
      validate: true,
      ignoreDuplicates: false,
      transaction
    }
  );

  // Create maps for lookups with validation
  const creatorMap = new Map();

  // First add existing creators to the map
  existingCreators.forEach(creator => {
    logCreatorDebug('Added to creatorMap from existing creators', creator.name, { 
      id: creator.id,
      existingRecord: true 
    });
    creatorMap.set(creator.name, creator.id);
  });

  // Then add newly created creators, mapping both their new name and original name (if different)
  creators.forEach(creator => {
    logCreatorDebug('Added to creatorMap from new creators', creator.name, { 
      id: creator.id,
      newRecord: true,
      originalName: creator.aliases[0] || creator.name
    });
    creatorMap.set(creator.name, creator.id);
    // If this was a duplicate, also map the original name to this ID
    if (creator.aliases.length > 0) {
      creatorMap.set(creator.aliases[0], creator.id);
      logCreatorDebug('Added alias mapping for duplicate', creator.aliases[0], {
        id: creator.id,
        newName: creator.name
      });
    }
  });

  // Bulk create all teams
  const teams = await Team.bulkCreate(
    Array.from(uniqueTeamNames).map(name => ({
      name,
      aliases: []
    })),
    {
      ignoreDuplicates: true,
      transaction
    }
  );

  const teamMap = new Map(teams.map(team => [team.name, team.id]));

  // Transform credit entries to include creator IDs
  const levelCreditEntries = creditEntries
    .map(entry => {
      const creatorId = creatorMap.get(entry.creatorName);
      logCreatorDebug('Transforming credit entry to include creator ID', entry.creatorName, {
        levelId: entry.levelId,
        role: entry.role,
        mappedCreatorId: creatorId
      });
      return {
        levelId: entry.levelId,
        creatorId: creatorId!,
        role: entry.role
      };
    })
    .filter(entry => entry.creatorId !== undefined);

  // Bulk create all level credits
  await LevelCredit.bulkCreate(levelCreditEntries, {
    ignoreDuplicates: true,
    transaction
  });

  // Auto-verify creators with 20 or more levels using in-memory data
  const creatorLevelCounts = new Map();
  levelCreditEntries.forEach(credit => {
    const count = (creatorLevelCounts.get(credit.creatorId) || 0) + 1;
    creatorLevelCounts.set(credit.creatorId, count);
  });

  // Merge creators with same name (case insensitive)
  console.log('Starting case-insensitive creator merge...');
  
  // Get all creators with their level counts
  const allCreators = await Creator.findAll({
    include: [{
      model: Level,
      as: 'createdLevels',
      through: { attributes: ['role'] }
    }],
    transaction
  });

  interface CreatorWithLevels extends Creator {
    createdLevels?: Level[];
  }

  interface CreatorEntry {
    creator: CreatorWithLevels;
    levelCount: number;
  }

  // Group creators by case-insensitive name
  const creatorsByName = new Map<string, CreatorEntry[]>();
  allCreators.forEach((creator: CreatorWithLevels) => {
    const lowerName = creator.name.toLowerCase();
    if (!creatorsByName.has(lowerName)) {
      creatorsByName.set(lowerName, []);
    }
    creatorsByName.get(lowerName)!.push({
      creator,
      levelCount: creator.createdLevels?.length || 0
    });
  });

  // Process each group that has multiple creators
  for (const [lowerName, creatorGroup] of creatorsByName) {
    if (creatorGroup.length > 1) {
      console.log(`Found ${creatorGroup.length} creators for name '${lowerName}'`);
      
      // Sort by level count descending to find the main creator
      creatorGroup.sort((a: CreatorEntry, b: CreatorEntry) => b.levelCount - a.levelCount);
      const mainCreator = creatorGroup[0].creator;
      const duplicates = creatorGroup.slice(1).map((c: CreatorEntry) => c.creator);

      console.log(`Merging to main creator '${mainCreator.name}' (${creatorGroup[0].levelCount} levels)`);

      // Transfer all credits to the main creator
      for (const duplicate of duplicates) {
        console.log(`- Merging '${duplicate.name}' (${duplicate.createdLevels?.length || 0} levels)`);
        
        // Get all credits for the duplicate creator
        const duplicateCredits = await LevelCredit.findAll({
          where: { creatorId: duplicate.id },
          transaction
        });

        // Transfer each credit using upsert
        for (const credit of duplicateCredits) {
          await LevelCredit.upsert({
            levelId: credit.levelId,
            creatorId: mainCreator.id,
            role: credit.role,
            isVerified: credit.isVerified
          }, { transaction });
        }

        // Delete all duplicate credits after transfer
        await LevelCredit.destroy({
          where: { creatorId: duplicate.id },
          transaction
        });

        // Add duplicate name as alias if it's different
        if (duplicate.name.toLowerCase() !== mainCreator.name.toLowerCase()) {
          mainCreator.aliases = [...(mainCreator.aliases || []), duplicate.name];
          await mainCreator.save({ transaction });
        }

        // Delete the duplicate creator
        await duplicate.destroy({ transaction });
      }
    }
  }

  console.log('Case-insensitive creator merge completed');

  // Get creators to verify and their level credits
  const creatorsToVerify = Array.from(creatorLevelCounts.entries())
    .filter(([_, count]) => count >= 20)
    .map(([creatorId]) => creatorId);

  if (creatorsToVerify.length > 0) {
    // Create verified creator records in bulk
    const verifiedCreatorData = creators
      .filter(creator => creatorsToVerify.includes(creator.id))
      .map(creator => ({
        ...creator.toJSON(),
        isVerified: true
      }));

    await Creator.bulkCreate(verifiedCreatorData, {
      updateOnDuplicate: ['isVerified'],
      transaction
    });

    // Create verified level credit records in bulk
    const verifiedCreditData = levelCreditEntries
      .filter(credit => creatorsToVerify.includes(credit.creatorId))
      .map(credit => ({
        ...credit,
        isVerified: true
      }));

    await LevelCredit.bulkCreate(verifiedCreditData, {
      updateOnDuplicate: ['isVerified'],
      transaction
    });

    console.log(`Auto-verified ${creatorsToVerify.length} creators with 20+ levels`);
  }

  console.log(`Credit migration completed: ${creators.length} creators, ${teams.length} teams, and ${levelCreditEntries.length} credits created`);
}

export async function migrateNewCredits(levels: Omit<ILevel, 'submitterDiscordId' | 'createdAt' | 'updatedAt'>[], transaction: Transaction): Promise<void> {
  console.log('Starting credit migration for new levels...');
  
  // First, collect all unique creator names and team names from new levels
  const uniqueCreatorNames = new Set<string>();
  const uniqueTeamNames = new Set<string>();
  const creditEntries: { levelId: number; creatorName: string; role: string }[] = [];
  const teamEntries: { levelId: number; teamName: string; creatorName: string }[] = [];

  // Get existing creators and teams first
  const existingCreators = await Creator.findAll({
    transaction
  });
  const existingTeams = await Team.findAll({
    transaction
  });

  const existingCreatorsByName = new Map(existingCreators.map(c => [c.name.toLowerCase(), c]));
  const existingTeamsByName = new Map(existingTeams.map(t => [t.name.toLowerCase(), t]));

  // Process all new levels to gather data
  for (const level of levels) {
    const credits = parseCredits(level.creator, level.charter, level.vfxer);
    
    // Add all creators to the unique set
    credits.charters.forEach(name => uniqueCreatorNames.add(name));
    credits.vfxers.forEach(name => uniqueCreatorNames.add(name));

    // Store credit relationships and team assignments
    if (credits.team && level.team && level.team.trim() !== '') {
      uniqueTeamNames.add(credits.team);
      
      credits.charters.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'charter' });
        teamEntries.push({ levelId: level.id, teamName: credits.team!, creatorName: name });
      });

      credits.vfxers.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'vfxer' });
        teamEntries.push({ levelId: level.id, teamName: credits.team!, creatorName: name });
      });
    } else {
      credits.charters.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'charter' });
      });
      credits.vfxers.forEach(name => {
        creditEntries.push({ levelId: level.id, creatorName: name, role: 'vfxer' });
      });
    }
  }

  // Filter out creators that already exist
  const newCreatorNames = Array.from(uniqueCreatorNames)
    .filter(name => !existingCreatorsByName.has(name.toLowerCase()));

  // Create only new creators
  if (newCreatorNames.length > 0) {
    const newCreators = await Creator.bulkCreate(
      newCreatorNames.map(name => ({
        name,
        aliases: [],
        isVerified: false
      })),
      {
        transaction
      }
    );

    // Add new creators to the existing map
    newCreators.forEach(creator => {
      existingCreatorsByName.set(creator.name.toLowerCase(), creator);
    });
  }

  // Filter out teams that already exist
  const newTeamNames = Array.from(uniqueTeamNames)
    .filter(name => !existingTeamsByName.has(name.toLowerCase()));

  // Create only new teams
  if (newTeamNames.length > 0) {
    const newTeams = await Team.bulkCreate(
      newTeamNames.map(name => ({
        name,
        aliases: []
      })),
      {
        transaction
      }
    );

    // Add new teams to the existing map
    newTeams.forEach(team => {
      existingTeamsByName.set(team.name.toLowerCase(), team);
    });
  }

  // Transform credit entries to include creator IDs
  const levelCreditEntries = creditEntries.map(entry => {
    const creator = existingCreatorsByName.get(entry.creatorName.toLowerCase());
    if (!creator) {
      console.warn(`Creator not found for name: ${entry.creatorName}`);
      return null;
    }
    return {
      levelId: entry.levelId,
      creatorId: creator.id,
      role: entry.role,
      isVerified: creator.isVerified
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // Create only new level credits
  if (levelCreditEntries.length > 0) {
    await LevelCredit.bulkCreate(levelCreditEntries, {
      ignoreDuplicates: true,
      transaction
    });
  }

  // Update team associations for new levels
  for (const level of levels) {
    if (level.team && level.team.trim() !== '') {
      const team = existingTeamsByName.get(level.team.toLowerCase());
      if (team) {
        await Level.update(
          { teamId: team.id },
          { 
            where: { id: level.id },
            transaction
          }
        );
      }
    }
  }

  console.log(`Credit migration completed for new levels: ${newCreatorNames.length} new creators, ${newTeamNames.length} new teams, and ${levelCreditEntries.length} new credits created`);
}