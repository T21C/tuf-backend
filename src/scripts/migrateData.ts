import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { User, OAuthProvider } from '../models/index.js';
import { CDN_PATHS } from '../config/constants.js';
import { getPfpUrl } from '../utils/pfpResolver.js';
import axios from 'axios';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();



const DISCORD_CDN = 'https://cdn.discordapp.com';

async function ensureDirectories() {
  await fs.mkdir(CDN_PATHS.avatars.original, { recursive: true });
  await fs.mkdir(CDN_PATHS.avatars.thumbnails, { recursive: true });
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function processAvatar(imageBuffer: Buffer, userId: string): Promise<void> {
  const timestamp = Date.now();
  const originalFilename = `${timestamp}_original.png`;
  const thumbnailFilename = `${timestamp}_thumbnail.png`;
  
  const originalPath = path.join(CDN_PATHS.avatars.original, userId);
  const thumbnailPath = path.join(CDN_PATHS.avatars.thumbnails, userId);
  
  // Create user-specific directories
  await fs.mkdir(originalPath, { recursive: true });
  await fs.mkdir(thumbnailPath, { recursive: true });

  // Save original
  await sharp(imageBuffer)
    .png()
    .toFile(path.join(originalPath, originalFilename));

  // Create and save thumbnail
  await sharp(imageBuffer)
    .resize(256, 256, {
      fit: 'cover',
      position: 'center'
    })
    .png()
    .toFile(path.join(thumbnailPath, thumbnailFilename));

  return;
}

async function migrateDiscordAvatars() {
  console.log('Migrating Discord avatars...');
  const providers = await OAuthProvider.findAll({
    where: { provider: 'discord' },
    include: [{ model: User, as: 'oauthUser' }]
  });

  for (const provider of providers) {
    try {
      const profile = provider.profile as any;
      if (!profile.avatar) continue;

      const avatarUrl = `${DISCORD_CDN}/avatars/${profile.id}/${profile.avatar}.png?size=1024`;
      const imageBuffer = await downloadImage(avatarUrl);
      
      await processAvatar(imageBuffer, provider.userId);
      
      // Update user's avatarUrl
      const cdnUrl = `${process.env.CDN_URL}/avatars/thumbnails/${provider.userId}/latest.png`;
      await provider.oauthUser?.update({ avatarUrl: cdnUrl });
      
      console.log(`Migrated avatar for user ${provider.userId}`);
    } catch (error) {
      console.error(`Failed to migrate avatar for user ${provider.userId}:`, error);
    }
  }
}

async function migrateChannelAvatars() {
  console.log('Migrating channel avatars...');
  const users = await User.findAll({
    where: {
      avatarUrl: {
        [Op.not]: null,
        [Op.like]: '%bilibili.com%'
      }
    }
  });

  for (const user of users) {
    try {
      if (!user.avatarUrl) continue;

      const pfpUrl = await getPfpUrl(user.avatarUrl);
      if (!pfpUrl) continue;

      const imageBuffer = await downloadImage(pfpUrl);
      await processAvatar(imageBuffer, user.id);
      
      // Update user's avatarUrl to use CDN
      const cdnUrl = `${process.env.CDN_URL}/avatars/thumbnails/${user.id}/latest.png`;
      await user.update({ avatarUrl: cdnUrl });
      
      console.log(`Migrated channel avatar for user ${user.id}`);
    } catch (error) {
      console.error(`Failed to migrate channel avatar for user ${user.id}:`, error);
    }
  }
}

async function migrateIconCache() {
  console.log('Migrating icon cache...');
  const iconCachePath = path.join(process.cwd(), 'cache', 'icons');
  
  try {
    const files = await fs.readdir(iconCachePath);
    
    for (const file of files) {
      try {
        const sourcePath = path.join(iconCachePath, file);
        const targetPath = path.join(CDN_PATHS.misc, 'icons', file);
        
        await fs.copyFile(sourcePath, targetPath);
        console.log(`Migrated icon: ${file}`);
      } catch (error) {
        console.error(`Failed to migrate icon ${file}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to read icon cache directory:', error);
  }
}

async function createSymlinks() {
  console.log('Creating latest.png symlinks...');
  const users = await User.findAll();

  for (const user of users) {
    try {
      if (!user.id) continue;
      
      const originalDir = path.join(CDN_PATHS.avatars.original, user.id);
      const thumbnailDir = path.join(CDN_PATHS.avatars.thumbnails, user.id);

      // Get the most recent avatar files
      const originalFiles = await fs.readdir(originalDir);
      const thumbnailFiles = await fs.readdir(thumbnailDir);

      if (originalFiles.length > 0) {
        const latestOriginal = originalFiles.sort().pop();
        if (latestOriginal) {
          const originalSymlink = path.join(originalDir, 'latest.png');
          await fs.symlink(latestOriginal, originalSymlink, 'file');
        }
      }

      if (thumbnailFiles.length > 0) {
        const latestThumbnail = thumbnailFiles.sort().pop();
        if (latestThumbnail) {
          const thumbnailSymlink = path.join(thumbnailDir, 'latest.png');
          await fs.symlink(latestThumbnail, thumbnailSymlink, 'file');
        }
      }
    } catch (error) {
      console.error(`Failed to create symlinks for user ${user.id}:`, error);
    }
  }
}

async function main() {
  try {
    await ensureDirectories();
    await migrateIconCache();
    await migrateDiscordAvatars();
    await migrateChannelAvatars();
    await createSymlinks();
    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main();
