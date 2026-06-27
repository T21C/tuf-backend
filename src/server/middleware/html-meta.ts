import {Request, Response, NextFunction} from 'express';
import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import Player from '@/models/players/Player.js';
import Difficulty from '@/models/levels/Difficulty.js';
import fs from 'fs';
import path from 'path';
import { logger } from '@/server/services/core/LoggerService.js';
import { clientUrlEnv, ownUrl } from '@/config/app.config.js';
import { User } from '@/models/index.js';
import { formatCreatorDisplay } from '@/misc/utils/Utility.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import LevelPack from '@/models/packs/LevelPack.js';
import { LevelPackViewModes } from '@/models/packs/index.js';
import { Op } from 'sequelize';
import { getArtistDisplayName, getSongDisplayName } from '@/misc/utils/data/levelHelpers.js';
import { getPrimaryVideoLink } from '@/misc/utils/data/videoLinkParts.js';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';

const SITE_NAME = 'The Universal Forums';
const DEFAULT_DESCRIPTION =
  'A community specialized in custom levels & clears of A Dance of Fire and Ice.';

const levelSongInclude = {
  model: Song,
  as: 'songObject',
  include: [{ model: Artist, as: 'artists' }],
};

const buildJsonLdScripts = (data: object | object[]) => {
  const blocks = Array.isArray(data) ? data : [data];
  return blocks
    .map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`)
    .join('\n          ');
};

const buildCanonicalTag = (path: string) =>
  `<link rel="canonical" href="${clientUrlEnv}${path}" />`;

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

// Function to read manifest file
const readManifest = async (): Promise<Manifest> => {
  const manifestPath = path.join(process.cwd(), '..', 'client', 'dist', '.vite', 'manifest.json');
    let attempts = 0;
    while (attempts < 3) {
      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        return JSON.parse(manifestContent);
      } catch (error: any) {
        if (!error.message.includes('ENOENT')) {
          throw {code: 500, skipLogging: true, error: error.message};
        }
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    throw {code: 500, skipLogging: true, error: 'Manifest not found after 15 seconds'};
  }
// Helper function to get all required assets
const getRequiredAssets = async (manifest: Manifest) => {
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

const BACKGROUND_BLURRED_MANIFEST_KEY =
  'src/assets/important/dark/background-blurred.jpg';

const getBackgroundBlurredUrl = (clientUrl: string, manifest?: Manifest) => {
  if (process.env.NODE_ENV === 'development') {
    return `${clientUrl}/src/assets/important/dark/background-blurred.jpg`;
  }

  const hashedPath = manifest?.[BACKGROUND_BLURRED_MANIFEST_KEY]?.file;
  return hashedPath
    ? `/${hashedPath}`
    : '/src/assets/important/dark/background-blurred.jpg';
};

// Base HTML template with Vite client
const getBaseHtml = async (clientUrl: string) => {
  if (process.env.NODE_ENV === 'development') {
    const backgroundImageUrl = getBackgroundBlurredUrl(clientUrl);
    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <link rel="icon" href="/favicon.ico" />
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
        <style>
          .background {
            position: fixed;
            inset: 0;
            z-index: 1;
            opacity: 0.9;
            background-image: url("${backgroundImageUrl}");
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            background-color: var(--color-black);
            -webkit-user-select: none;
            -khtml-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
            user-select: none;
          }
        </style>
        <body>
          <div class="background"></div>
          <div id="root"></div>
        </body>
      </html>
    `;
  }

  // Production mode - use manifest
  const manifest = await readManifest();
  const { js, css, imports } = await getRequiredAssets(manifest);

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
  const faviconPath = manifest['src/assets/tuf-logo/logo.svg']?.file
    ? `/${manifest['src/assets/tuf-logo/logo.svg'].file}`
    : '/logo.svg';

  const backgroundImageUrl = getBackgroundBlurredUrl(clientUrl, manifest);

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
            <style>
        .background {
          position: fixed;
          inset: 0;
          z-index: 1;
          opacity: 0.9;
          background-image: url("${backgroundImageUrl}");
          background-size: cover;
          background-position: center;
          background-repeat: no-repeat;
          background-color: var(--color-black);
          -webkit-user-select: none;
          -khtml-user-select: none;
          -moz-user-select: none;
          -ms-user-select: none;
          user-select: none;
        }
        .root {
          z-index: 2;
          position: relative;
        }
      </style>
      <body>
        <div class="background"></div>
        <div class="root" id="root"></div>
      </body>
    </html>
  `;
};

export const htmlMetaMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  //logger.debug('HTML Meta Middleware', req.path);
  try {
    const id = req.params.id;
    let metaTags = `
    <title>${SITE_NAME}</title>
    <meta name="description" content="${DEFAULT_DESCRIPTION}" />
    <link rel="canonical" href="${clientUrlEnv}/" />
    <meta name="robots" content="index,follow" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:type" content="website" />
    <meta name="theme-color" content="#090909" />`;

    const notFoundTags =`
      <title>Not found | ${SITE_NAME}</title>
      <meta name="robots" content="noindex,follow" />
      <meta property="og:site_name" content="${SITE_NAME}" />
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
            include: [
              { model: Difficulty, as: 'difficulty' },
              levelSongInclude,
            ],
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
        const songName = escapeMetaText(getSongDisplayName(pass.level));
        const artistName = escapeMetaText(getArtistDisplayName(pass.level));
        const pageTitle = escapeMetaText(`${playerName}'s Clear of ${songName} - ${artistName}`);
        const pageDescription = escapeMetaText(
          `${playerName} cleared ${songName} by ${artistName} — ${difficultyName} · Score ${pass.scoreV2}`,
        );
        const canonicalPath = req.path;
        const pageUrl = `${clientUrlEnv}${canonicalPath}`;
        const thumbnailUrl = `${ownUrl}/v2/media/thumbnail/pass/${id}`;

        metaTags = `
          <title>${pageTitle} | ${SITE_NAME}</title>
          <meta name="description" content="${pageDescription}" />
          ${buildCanonicalTag(canonicalPath)}
          <meta name="robots" content="index,follow" />
          <meta property="og:site_name" content="${SITE_NAME}" />
          <meta property="og:type" content="article" />
          <meta property="og:title" content="${pageTitle}" />
          <meta property="og:description" content="${pageDescription}" />
          <meta property="og:image" content="${thumbnailUrl}" />
          <meta property="og:image:width" content="800" />
          <meta property="og:image:height" content="420" />
          <meta property="twitter:card" content="summary_large_image" />
          <meta property="twitter:title" content="${pageTitle}" />
          <meta property="twitter:description" content="${pageDescription}" />
          <meta property="twitter:image" content="${thumbnailUrl}" />
          <meta name="theme-color" content="#090909" />
          <meta property="og:url" content="${pageUrl}" />
          ${buildJsonLdScripts([
            {
              '@context': 'https://schema.org',
              '@type': 'VideoObject',
              name: pageTitle,
              description: pageDescription,
              url: getPrimaryVideoLink(pass.videoLink) || pageUrl,
              thumbnailUrl,
            },
          ])}`;
      }
      else {
        metaTags = notFoundTags.replace('Not found', 'Pass not found')
      }
    }
    else if (req.path.startsWith('/levels/')) {
      const level = await Level.findByPk(id, {
        include: [
          { model: Difficulty, as: 'difficulty' },
          levelSongInclude,
          {
            model: LevelCredit,
            as: 'levelCredits',
            include: [{ model: Creator, as: 'creator' }],
          },
        ],
      });

      if (level && !level.isDeleted && !level.isHidden) {
        const creators = escapeMetaText(formatCreatorDisplay(level));
        const songName = escapeMetaText(getSongDisplayName(level));
        const artistName = escapeMetaText(getArtistDisplayName(level));
        const pageTitle = escapeMetaText(`${songName} - ${artistName}`);
        const pageDescription = escapeMetaText(
          `${songName} by ${artistName} — charted by ${creators} on ${SITE_NAME}`,
        );
        const canonicalPath = req.path;
        const pageUrl = `${clientUrlEnv}${canonicalPath}`;
        const thumbnailUrl = `${ownUrl}/v2/media/thumbnail/level/${id}`;

        metaTags = `
          <title>${pageTitle} | ${SITE_NAME}</title>
          <meta name="description" content="${pageDescription}" />
          ${buildCanonicalTag(canonicalPath)}
          <meta name="robots" content="index,follow" />
          <meta property="og:site_name" content="${SITE_NAME}" />
          <meta property="og:type" content="article" />
          <meta property="og:title" content="${pageTitle}" />
          <meta property="og:description" content="${pageDescription}" />
          <meta property="og:image" content="${thumbnailUrl}" />
          <meta property="og:image:width" content="800" />
          <meta property="og:image:height" content="420" />
          <meta property="twitter:card" content="summary_large_image" />
          <meta property="twitter:title" content="${pageTitle}" />
          <meta property="twitter:description" content="${pageDescription}" />
          <meta property="twitter:image" content="${thumbnailUrl}" />
          <meta name="theme-color" content="${level.difficulty?.color || '#090909'}" />
          <meta property="og:url" content="${pageUrl}" />
          ${buildJsonLdScripts([
            {
              '@context': 'https://schema.org',
              '@type': 'CreativeWork',
              name: pageTitle,
              description: pageDescription,
              url: pageUrl,
              image: thumbnailUrl,
              creator: {
                '@type': 'Person',
                name: creators,
              },
            },
          ])}`;
      }
      else{
        metaTags = notFoundTags.replace('Not found', 'Level not found');
      }
    }
    else if (req.path.startsWith('/profile/')) {
      const player = await Player.findByPk(id, {
        include: [{model: User, as: 'user'}],
      });

      if (player && !player.isBanned) {
        const playerName = escapeMetaText(player.name);
        const pageTitle = escapeMetaText(playerName);
        const pageDescription = escapeMetaText(
          `Check out ${playerName}'s profile, clears, and achievements on ${SITE_NAME}`,
        );
        const canonicalPath = req.path;
        const pageUrl = `${clientUrlEnv}${canonicalPath}`;
        const thumbnailUrl = `${ownUrl}/v2/media/thumbnail/player/${id}`;

        metaTags = `
          <title>${pageTitle} | ${SITE_NAME}</title>
          <meta name="description" content="${pageDescription}" />
          ${buildCanonicalTag(canonicalPath)}
          <meta name="robots" content="index,follow" />
          <meta property="og:site_name" content="${SITE_NAME}" />
          <meta property="og:type" content="profile" />
          <meta property="og:title" content="${pageTitle}" />
          <meta property="og:description" content="${pageDescription}" />
          <meta property="og:image" content="${thumbnailUrl}" />
          <meta property="og:image:width" content="800" />
          <meta property="og:image:height" content="420" />
          <meta property="twitter:card" content="summary_large_image" />
          <meta property="twitter:title" content="${pageTitle}" />
          <meta property="twitter:description" content="${pageDescription}" />
          <meta property="twitter:image" content="${thumbnailUrl}" />
          <meta name="theme-color" content="#090909" />
          <meta property="og:url" content="${pageUrl}" />
          ${buildJsonLdScripts([
            {
              '@context': 'https://schema.org',
              '@type': 'ProfilePage',
              name: pageTitle,
              url: pageUrl,
              mainEntity: {
                '@type': 'Person',
                name: playerName,
                url: pageUrl,
                image: thumbnailUrl,
              },
            },
          ])}`;
      }
      else {
        metaTags = notFoundTags.replace('Not found', 'Player not found');
      }
    }
    else if (req.path.startsWith('/packs/')) {
      const pack = await LevelPack.findOne({where: {linkCode: id, viewMode: {[Op.or]: [LevelPackViewModes.PUBLIC, LevelPackViewModes.LINKONLY]}}});
      if (pack) {
        const packName = escapeMetaText(pack.name);
        const owner = await User.findByPk(pack.ownerId);
        const ownerName = escapeMetaText(owner?.nickname || owner?.username || 'Unknown Owner');
        const pageTitle = escapeMetaText(packName);
        const pageDescription = escapeMetaText(
          `Level pack ${packName} by ${ownerName} on ${SITE_NAME}`,
        );
        const canonicalPath = `/packs/${pack.linkCode}`;
        const pageUrl = `${clientUrlEnv}${canonicalPath}`;
        const thumbnailUrl = `${ownUrl}/v2/media/thumbnail/pack/${pack.linkCode}`;

        metaTags = `
          <title>${pageTitle} - Pack | ${SITE_NAME}</title>
          <meta name="description" content="${pageDescription}" />
          ${buildCanonicalTag(canonicalPath)}
          <meta name="robots" content="index,follow" />
          <meta property="og:site_name" content="${SITE_NAME}" />
          <meta property="og:type" content="website" />
          <meta property="og:title" content="${pageTitle}" />
          <meta property="og:description" content="${pageDescription}" />
          <meta property="og:image" content="${thumbnailUrl}" />
          <meta property="og:image:width" content="800" />
          <meta property="og:image:height" content="420" />
          <meta property="twitter:card" content="summary_large_image" />
          <meta property="twitter:title" content="${pageTitle}" />
          <meta property="twitter:description" content="${pageDescription}" />
          <meta property="twitter:image" content="${thumbnailUrl}" />
          <meta name="theme-color" content="#090909" />
          <meta property="og:url" content="${pageUrl}" />
          ${buildJsonLdScripts([
            {
              '@context': 'https://schema.org',
              '@type': 'CollectionPage',
              name: pageTitle,
              description: pageDescription,
              url: pageUrl,
            },
          ])}`;
      }
      else {
        metaTags = notFoundTags.replace('Not found', 'Pack not found');
      }
    }
    const html = await getBaseHtml(clientUrlEnv || '').then(html => html.replace(
        '<!-- METADATA_PLACEHOLDER -->',
        metaTags,
      ));
    return res.send(html);
  } catch (error: any) {
    if (!error.skipLogging) {
      logger.error('Error serving HTML:', error);
    }
    return next(error);
  }
};
