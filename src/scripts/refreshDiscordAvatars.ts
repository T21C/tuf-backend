import sequelize from '../config/db.js';
import User from '../models/User.js';
import { fetchDiscordUserInfo } from '../utils/discord.js';
import { initializeAssociations } from '../models/associations.js';
import { Op } from 'sequelize';
import OAuthProvider from '../models/OAuthProvider.js';

const BATCH_SIZE = 100;
const RATE_LIMIT_DELAY = 1000; // 1 second between batches

// Parse command line arguments
const args = process.argv.slice(2);
const shouldReset = args.includes('--reset');

async function refreshDiscordAvatars() {
  try {
    console.log('Starting Discord avatar refresh...');

    // If reset flag is provided, clear all avatar URLs first
    if (shouldReset) {
      console.log('Starting from scratch...');
    }

    // First, get all users with Discord IDs
    const users = await User.findAll({
      where: shouldReset ? {} : {
        avatarUrl: null
      },
      include: [
        {
          model: OAuthProvider,
          where: {
            provider: 'discord'
          },
          as: 'providers'
        }
      ]
    });

    console.log(`Found ${users.length} users with Discord IDs${shouldReset ? '' : ' needing avatar updates'}`);

    // Process users in batches to handle rate limits
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(users.length/BATCH_SIZE)}`);

      // Process each user in the batch
      for (const user of batch) {
        try {
          if (!user.providers || !user.providers[0].providerId) {
            console.log(`Skipping user ${user.id} - no Discord provider ID found`);
            continue;
          }

          // Fetch new Discord info
          const discordInfo = await fetchDiscordUserInfo(user.providers[0].providerId);
          
          // Construct avatar URL if available
          let newAvatarUrl = null;
          if (discordInfo.avatar) {
            newAvatarUrl = `https://cdn.discordapp.com/avatars/${user.providers[0].providerId}/${discordInfo.avatar}.png`;
          }

          // Update user with new info
          await user.update({
            username: discordInfo.username,
            avatarUrl: newAvatarUrl
          });

          console.log(`Updated user ${user.id} (${discordInfo.username})`);
        } catch (error) {
          if (error instanceof Error) {
            console.error(`Error updating user ${user.id}:`, error.message);
            // Don't throw error, continue with next user
          }
        }
      }

      // Add delay between batches to respect rate limits
      if (i + BATCH_SIZE < users.length) {
        console.log(`Waiting ${RATE_LIMIT_DELAY}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
      }
    }

    console.log('\nDiscord avatar refresh completed successfully!');

  } catch (error) {
    console.error('Error during Discord avatar refresh:', error);
    throw error;
  }
}

// Execute the script
sequelize.authenticate()
  .then(() => {
    initializeAssociations();
    console.log('Database connection established successfully.');
    return refreshDiscordAvatars();
  })
  .then(() => {
    console.log('Script completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  }); 