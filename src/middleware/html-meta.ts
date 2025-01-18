import { Request, Response, NextFunction } from 'express';
import Pass from '../models/Pass';
import Level from '../models/Level';
import Player from '../models/Player';
import Difficulty from '../models/Difficulty';

const clientUrlEnv = process.env.NODE_ENV === 'production' 
? process.env.PROD_CLIENT_URL 
: process.env.NODE_ENV === 'staging'
? process.env.STAGING_CLIENT_URL
: process.env.NODE_ENV === 'development'
? process.env.CLIENT_URL 
: 'http://localhost:5173';


const portEnv = process.env.NODE_ENV === 'production' 
? process.env.PROD_PORT 
: process.env.NODE_ENV === 'staging'
? process.env.STAGING_PORT
: process.env.NODE_ENV === 'development'
? process.env.PORT
: '3002';

const ownUrlEnv = process.env.NODE_ENV === 'production' 
? process.env.PROD_API_URL 
: process.env.NODE_ENV === 'staging'
? process.env.STAGING_API_URL
: process.env.NODE_ENV === 'development'
? process.env.OWN_URL
: 'http://localhost:3002';


// Base HTML template with Vite client
const getBaseHtml = (clientUrl: string) => `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <base href="${clientUrl}/" />
    <link rel="icon" type="image/svg+xml" href="/src/assets/tuf-logo/logo.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta property="og:site_name" content="The Universal Forum" />
    <meta name="theme-color" content="#090909" />
    <!-- METADATA_PLACEHOLDER -->
    <script type="module">
      import RefreshRuntime from '${clientUrl}/@react-refresh'
      RefreshRuntime.injectIntoGlobalHook(window)
      window.$RefreshReg$ = () => {}
      window.$RefreshSig$ = () => (type) => type
      window.__vite_plugin_react_preamble_installed__ = true
    </script>
    <script type="module" src="${clientUrl}/@vite/client"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${clientUrl}/src/main.jsx"></script>
  </body>
</html>`;

export const htmlMetaMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    let metaTags = '';
    
    if (req.path.startsWith('/passes/')) {
      
      const pass = await Pass.findByPk(id, {
        include: [
          {
            model: Level,
            as: 'level',
            include: [{ model: Difficulty, as: 'difficulty' }]
          },
          {
            model: Player,
            as: 'player'
          }
        ]
      });

      if (pass && pass.player && pass.level) {
        metaTags = `
    <meta property="og:title" content="${pass.player.name}'s Clear of ${pass.level.song}" />
    <meta property="og:description" content="Pass ${pass.id} • ${pass.level.difficulty?.name || 'Unknown Difficulty'} • Score: ${pass.scoreV2}" />
    <meta property="og:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
      }
    } else if (req.path.startsWith('/levels/')) {
      // Handle level pages similarly if needed
      metaTags = `
    <meta property="og:title" content="Level ${id}" />
    <meta property="og:description" content="View level details" />
    <meta property="og:image" content="${ownUrlEnv}/v2/media/thumbnail/level/${id}" />
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:image" content="${ownUrlEnv}/v2/media/thumbnail/level/${id}" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
    }

    if (req.path.startsWith('/player/')) {
      metaTags = `
    <meta property="og:title" content="Player ${id}" />
    <meta property="og:description" content="View player details" />
    <meta property="og:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:image" content="${ownUrlEnv}/v2/media/image/soggycat.webp" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta property="og:url" content="${clientUrlEnv}${req.path}" />`;
    }


    // Insert meta tags into HTML
    const html = getBaseHtml(clientUrlEnv || '').replace('<!-- METADATA_PLACEHOLDER -->', metaTags);

    // Set appropriate headers and send response
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Error serving HTML:', error);
    next(error);
  }
}; 