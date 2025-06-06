import {Request, Response, NextFunction} from 'express';
import Pass from '../models/passes/Pass.js';
import Level from '../models/levels/Level.js';
import Player from '../models/players/Player.js';
import Difficulty from '../models/levels/Difficulty.js';
import Creator from '../models/credits/Creator.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../services/LoggerService.js';
import { clientUrlEnv, ownUrl } from '../config/app.config.js';
// Add type for manifest entries
type ManifestEntry = {
  file: string;
  css?: string[];
  imports?: string[];
  assets?: string[];
};

type Manifest = {
  [key: string]: ManifestEntry;
};

// Read manifest once at startup
const manifestPath = path.join(process.cwd(), '..', 'client', 'dist', '.vite', 'manifest.json');
let manifest: Manifest = {};

try {
  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  manifest = JSON.parse(manifestContent);
} catch (error) {
  logger.error('Error reading manifest file:', error);
}

// Helper function to get all required assets
const getRequiredAssets = () => {
  const entry = manifest['index.html'];
  if (!entry) return { js: [], css: [], imports: [] };

  const js = [entry.file];
  const css = entry.css || [];
  const imports = entry.imports?.map(imp => manifest[imp]?.file).filter(Boolean) || [];

  return { js, css, imports };
};

// Function to escape special characters for meta tags
const escapeMetaText = (text: string): string => {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

// Base HTML template with Vite client
const getBaseHtml = (clientUrl: string) => {
  if (process.env.NODE_ENV === 'development') {
    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <link rel="icon" type="image/svg+xml" href="/src/assets/tuf-logo/logo.png" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          
          <!-- METADATA_PLACEHOLDER -->

          <script type="module">
            import RefreshRuntime from '${clientUrl}/@react-refresh'
            RefreshRuntime.injectIntoGlobalHook(window)
            window.$RefreshReg$ = () => {}
            window.$RefreshSig$ = () => (type) => type
            window.__vite_plugin_react_preamble_installed__ = true
          </script>
          <script type="module" src="${clientUrl}/@vite/client"></script>
          <script type="module" src="${clientUrl}/src/main.jsx"></script>
        </head>
        <body>
          <div id="root"></div>
        </body>
      </html>
    `;
  }

  // Production mode - use manifest
  const { js, css, imports } = getRequiredAssets();
  
  // Get vendor and UI chunks from manifest
  const vendorChunk = Object.entries(manifest).find(([key]) => key.includes('vendor'))?.[1]?.file;
  const uiChunk = Object.entries(manifest).find(([key]) => key.includes('ui'))?.[1]?.file;
  
  const modulePreloads = [
    vendorChunk ? `<link rel="modulepreload" crossorigin href="/${vendorChunk}">` : '',
    uiChunk ? `<link rel="modulepreload" crossorigin href="/${uiChunk}">` : ''
  ].filter(Boolean).join('\n');
  
  const cssLinks = css.map(file => 
    `<link rel="stylesheet" crossorigin href="/${file}">`
  ).join('\n');
  
  const jsScripts = [
    ...imports.map(file => 
      `<script type="module" crossorigin src="/${file}"></script>`
    ),
    `<script type="module" crossorigin src="/${js[0]}"></script>`
  ].join('\n');

  // Get favicon path from manifest or fallback
  const faviconPath = manifest['src/assets/tuf-logo/logo.png']?.file 
    ? `/${manifest['src/assets/tuf-logo/logo.png'].file}`
    : '/logo.png';

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <link rel="icon" type="image/svg+xml" href="${faviconPath}" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        
        <!-- METADATA_PLACEHOLDER -->

        ${modulePreloads}
        ${cssLinks}
        ${jsScripts}
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  `;
};

export const htmlMetaMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = req.params.id;
    let metaTags = `
    <meta name="description" content="The Universal Forum - A community for rhythm game players" />
    <meta property="og:site_name" content="The Universal Forum" />
    <meta property="og:type" content="website" />
    <meta name="theme-color" content="#090909" />`;

    const notFoundTags =`
      <meta property="og:site_name" content="The Universal Forum" />
      <meta property="og:type" content="website" />
      <meta property="og:title" content="Not found" />
      <meta name="theme-color" content="#330000" />
    `


    if (req.path.startsWith('/passes/')) {
      const pass = await Pass.findByPk(id, {
        include: [
          {
            model: Level,
            as: 'level',
            include: [{model: Difficulty, as: 'difficulty'}],
          },
          {
            model: Player,
            as: 'player',
          },
        ],
      });

      if (pass && !pass.isDeleted && pass.player && pass.level) {
        const difficultyName = escapeMetaText(pass.level.difficulty?.name || 'Unknown Difficulty');
        const playerName = escapeMetaText(pass.player.name);
        const songName = escapeMetaText(pass.level.song);
        
        metaTags = `
          <meta name="description" content="${difficultyName} • Score: ${pass.scoreV2}" />
          <meta property="og:site_name" content="The Universal Forum" />
          <meta property="og:type" content="website" />
          <meta property="og:title" content="${playerName}'s Clear of ${songName}" />
          <meta property="og:description" content="Pass ${pass.id} • ${difficultyName} • Score: ${pass.scoreV2}" />
          <meta property="og:image" content="${ownUrl}/v2/media/image/soggycat.webp" />
          <meta property="og:image:width" content="800" />
          <meta property="og:image:height" content="420" />
          <meta property="twitter:card" content="summary_large_image" />
          <meta property="twitter:image" content="${ownUrl}/v2/media/image/soggycat.webp" />
          <meta name="theme-color" content="#090909" />
          <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
      }
      else {
        metaTags = notFoundTags.replace('Not found', 'Pass not found')
      }
    } 
    else if (req.path.startsWith('/levels/')) {
      const level = await Level.findByPk(id, {
        include: [
          {model: Difficulty, as: 'difficulty'},
          {
            model: Creator,
            as: 'levelCreators',
          },
        ],
      });

      if (level && !level.isDeleted && !level.isHidden) {
        const creators =
          level.levelCreators
            ?.map((creator: any) => {
              return escapeMetaText(creator.name || 'Unknown');
            })
            .filter(Boolean)
            .join(', ') || 'Unknown Creator';

        const songName = escapeMetaText(level.song);
        const artistName = escapeMetaText(level.artist);
        
        metaTags = `
          <meta name="description" content="Created by ${creators}" />
          <meta property="og:site_name" content="The Universal Forum" />
          <meta property="og:type" content="website" />
          <meta property="og:title" content="${songName} by ${artistName}" />
          <meta property="og:description" content="Created by ${creators}" />
          <meta property="og:image" content="${ownUrl}/v2/media/thumbnail/level/${id}" />
          <meta property="og:image:width" content="800" />
          <meta property="og:image:height" content="420" />
          <meta property="twitter:card" content="summary_large_image" />
          <meta property="twitter:image" content="${ownUrl}/v2/media/thumbnail/level/${id}" />
          <meta name="theme-color" content="${level.difficulty?.color || '#090909'}" />
          <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
      }
      else{
        metaTags = notFoundTags.replace('Not found', 'Level not found');
      }
    }
    else if (req.path.startsWith('/player/')) {
      const player = await Player.findByPk(id, {
        include: [{model: Level, as: 'levels'}],
      });

      if (player && !player.isBanned) {
        metaTags = `
          <meta name="description" content="View player details" />
          <meta property="og:site_name" content="The Universal Forum" />
          <meta property="og:type" content="website" />
          <meta property="og:title" content="Player ${id}" />
          <meta property="og:description" content="View player details" />
          <meta property="og:image" content="${ownUrl}/v2/media/image/soggycat.webp" />
          <meta property="og:image:width" content="800" />
          <meta property="og:image:height" content="420" />
          <meta property="twitter:card" content="summary_large_image" />
          <meta property="twitter:image" content="${ownUrl}/v2/media/image/soggycat.webp" />
          <meta name="theme-color" content="#090909" />
          <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
      }
      else {
        metaTags = notFoundTags.replace('Not found', 'Player not found');
      }
    }
    const html = getBaseHtml(clientUrlEnv || '').replace(
      '<!-- METADATA_PLACEHOLDER -->',
      metaTags,
    );
    res.send(html);
  } catch (error) {
    logger.error('Error serving HTML:', error);
    next(error);
  }
};
