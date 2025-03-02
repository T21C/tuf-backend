import fs from 'fs/promises';
import path from 'path';
import { CDN_PATHS } from '../config/constants.js';

async function setupCDN() {
  try {
    console.log('Setting up CDN directories...');

    // Create all CDN directories
    await fs.mkdir(CDN_PATHS.root, { recursive: true });
    await fs.mkdir(CDN_PATHS.avatars.original, { recursive: true });
    await fs.mkdir(CDN_PATHS.avatars.thumbnails, { recursive: true });
    await fs.mkdir(CDN_PATHS.levels.published, { recursive: true });
    await fs.mkdir(CDN_PATHS.levels.drafts, { recursive: true });
    await fs.mkdir(CDN_PATHS.temp, { recursive: true });
    await fs.mkdir(CDN_PATHS.misc, { recursive: true });
    await fs.mkdir(path.join(CDN_PATHS.misc, 'icons'), { recursive: true });

    console.log('CDN directories created successfully.');

    // Set appropriate permissions (readable by web server)
    const dirs = [
      CDN_PATHS.root,
      CDN_PATHS.avatars.original,
      CDN_PATHS.avatars.thumbnails,
      CDN_PATHS.levels.published,
      CDN_PATHS.levels.drafts,
      CDN_PATHS.temp,
      CDN_PATHS.misc,
      path.join(CDN_PATHS.misc, 'icons')
    ];

    for (const dir of dirs) {
      await fs.chmod(dir, 0o755); // rwxr-xr-x
    }

    console.log('Permissions set successfully.');
    
    // Create .gitignore in CDN root
    const gitignore = `
# Ignore all files in CDN directories
*
!.gitignore
    `.trim();

    await fs.writeFile(path.join(CDN_PATHS.root, '.gitignore'), gitignore);
    console.log('Created .gitignore in CDN root.');

    console.log('CDN setup completed successfully!');
  } catch (error) {
    console.error('Error setting up CDN:', error);
    process.exit(1);
  }
}

setupCDN(); 