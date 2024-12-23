import { raterList, SUPER_ADMINS } from "../config/constants";
import { Rater } from "../services/RaterService";
import { fetchDiscordUserInfo } from "./discord";

// Process a batch of raters with rate limit awareness
async function processBatch(batch: string[], transaction: any) {
  const batchResults = [];
  
  // Process each rater sequentially to respect rate limits
  for (const discordId of batch) {
    try {
      const discordInfo = await fetchDiscordUserInfo(discordId);

      // Create rater with Discord info and super admin status
      const isSuperAdmin = SUPER_ADMINS.includes(discordInfo.username);
      const rater = await Rater.create({
        discordId,
        discordUsername: discordInfo.username,
        discordAvatar: discordInfo.avatar,
        isSuperAdmin
      }, { 
        transaction
      });
      

      batchResults.push(rater);
    } catch (error) {
      console.error(`Failed to process rater ${discordId}:`, error);
      // Continue with next rater
    }
  }

  return batchResults;
}

export async function populateRaters(transaction: any) {
  try {
    console.log('Starting rater population...');
    const BATCH_SIZE = 10;
    const createdRaters = [];

    // Process raters in batches
    for (let i = 0; i < raterList.length; i += BATCH_SIZE) {
      const batch = raterList.slice(i, i + BATCH_SIZE);

      const batchResults = await processBatch(batch, transaction);
      createdRaters.push(...batchResults);
    }

    const expectedTotal = raterList.length;
    console.log(`${createdRaters.length} total raters created`);

    // Verify all raters were created
    const totalRaters = await Rater.count({ transaction });

    if (totalRaters !== expectedTotal) {
      // Get all raters to check what's actually in the database
      const dbRaters = await Rater.findAll({ transaction });
      const existingIds = dbRaters.map(r => r.discordId);
      const missingIds = raterList.filter(id => !existingIds.includes(id));
      
      console.warn(
        `Rater count mismatch: expected ${expectedTotal}, got ${totalRaters}\n` +
        `Missing rater IDs: ${missingIds.join(', ')}`
      );
    }
  } catch (error) {
    console.error('Error populating raters:', error);
    throw error;
  }
}
  