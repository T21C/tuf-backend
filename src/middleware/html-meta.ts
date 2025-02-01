import {Request, Response, NextFunction} from 'express';
import Pass from '../models/Pass.js';
import Level from '../models/Level.js';
import Player from '../models/Player.js';
import Difficulty from '../models/Difficulty.js';
import Creator from '../models/Creator.js';
import fs from 'fs';
import path from 'path';

const clientUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_CLIENT_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_CLIENT_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.CLIENT_URL
        : 'http://localhost:5173';

/* eslint-disable @typescript-eslint/no-unused-vars */
const portEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_PORT
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_PORT
      : process.env.NODE_ENV === 'development'
        ? process.env.PORT
        : '3002';

const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

// Add this near the top with other constants
const manifestPath = path.join(process.cwd(), '..', 'client', 'dist', '.vite', 'manifest.json');
let manifest: Record<string, { file: string }> = {};

try {
  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  manifest = JSON.parse(manifestContent);
} catch (error) {
  console.error('Error reading manifest file:', error);
}

// Base HTML template with Vite client
const getBaseHtml = (clientUrl: string) => `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <base href="${clientUrl}/" />
    <link rel="icon" type="image/svg+xml" href="/assets/logo.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    
    <!-- METADATA_PLACEHOLDER -->

    ${
      process.env.NODE_ENV === 'development'
        ? `<script type="module">
          import RefreshRuntime from '${clientUrl}/@react-refresh'
          RefreshRuntime.injectIntoGlobalHook(window)
          window.$RefreshReg$ = () => {}
          window.$RefreshSig$ = () => (type) => type
          window.__vite_plugin_react_preamble_installed__ = true
        </script>
        <script type="module" src="${clientUrl}/@vite/client"></script>
        <script type="module" src="${clientUrl}/src/main.jsx"></script>`
        : `<link rel="stylesheet" href="${manifest['index.css']?.file ? '/' + manifest['index.css'].file : '/assets/index.css'}" />
         <script type="module" crossorigin src="${manifest['index.html']?.file ? '/' + manifest['index.html'].file : '/assets/index.js'}"></script>
         <link rel="modulepreload" href="${manifest['vendor']?.file ? '/' + manifest['vendor'].file : '/assets/vendor.js'}" />
         <link rel="modulepreload" href="${manifest['ui']?.file ? '/' + manifest['ui'].file : '/assets/ui.js'}" />`
    }
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

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

      if (pass && pass.player && pass.level) {
        metaTags = `
    <meta name="description" content="${pass.level.difficulty?.name || 'Unknown Difficulty'} • Score: ${pass.scoreV2}" />
    <meta property="og:site_name" content="The Universal Forum" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${pass.player.name}'s Clear of ${pass.level.song}" />
    <meta property="og:description" content="Pass ${pass.id} • ${pass.level.difficulty?.name || 'Unknown Difficulty'} • Score: ${pass.scoreV2}" />
    <meta property="og:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta name="theme-color" content="#090909" />
    <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
      }
    } else if (req.path.startsWith('/levels/')) {
      const level = await Level.findByPk(id, {
        include: [
          {model: Difficulty, as: 'difficulty'},
          {
            model: Creator,
            as: 'levelCreators',
          },
        ],
      });

      if (level) {
        const creators =
          level.levelCreators
            ?.map((creator: any) => {
              return creator.name || 'Unknown';
            })
            .filter(Boolean)
            .join(', ') || 'Unknown Creator';

        metaTags = `
    <meta name="description" content="Created by ${creators}" />
    <meta property="og:site_name" content="The Universal Forum" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${level.song} by ${level.artist}" />
    <meta property="og:description" content="Created by ${creators}" />
    <meta property="og:image" content="${ownUrlEnv}/v2/media/thumbnail/level/${id}" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:image" content="${ownUrlEnv}/v2/media/thumbnail/level/${id}" />
    <meta name="theme-color" content="${level.difficulty?.color || '#090909'}" />
    <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
      }
    } else if (req.path.startsWith('/player/')) {
      metaTags = `
    <meta name="description" content="View player details" />
    <meta property="og:site_name" content="The Universal Forum" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Player ${id}" />
    <meta property="og:description" content="View player details" />
    <meta property="og:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta name="theme-color" content="#090909" />
    <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
    }

    // Insert meta tags into HTML
    const html = getBaseHtml(clientUrlEnv || '').replace(
      '<!-- METADATA_PLACEHOLDER -->',
      metaTags,
    );


    res.send(html);
  } catch (error) {
    console.error('Error serving HTML:', error);
    next(error);
  }
};
