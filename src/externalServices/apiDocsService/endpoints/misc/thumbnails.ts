import { EndpointDefinition } from '../../services/DocumentationService.js';

export const thumbnailsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/misc/media/thumbnail/level/:levelId',
    description: 'Generate or retrieve a cached thumbnail image for a level. Supports multiple sizes (SMALL, MEDIUM, LARGE). Thumbnails are cached and regenerated as needed.',
    category: 'MEDIA',
    parameters: {
      path: {
        levelId: 'number (required, 1-20 digits) - Level ID'
      },
      query: {
        size: 'string (optional, default: "MEDIUM") - Thumbnail size: "SMALL" | "MEDIUM" | "LARGE"'
      }
    },
    responses: {
      '200': 'Returns PNG image',
      '404': 'Level not found, deleted, or hidden',
      '500': 'Error generating image'
    }
  },
  {
    method: 'GET',
    path: '/v2/misc/media/thumbnail/player/:id',
    description: 'Generate or retrieve a cached thumbnail image for a player profile. Supports multiple sizes (SMALL, MEDIUM, LARGE). Thumbnails are cached and regenerated as needed.',
    category: 'MEDIA',
    parameters: {
      path: {
        id: 'number (required, 1-20 digits) - Player ID'
      },
      query: {
        size: 'string (optional, default: "MEDIUM") - Thumbnail size: "SMALL" | "MEDIUM" | "LARGE"'
      }
    },
    responses: {
      '200': 'Returns PNG image',
      '404': 'Player not found',
      '500': 'Error generating image'
    }
  },
  {
    method: 'GET',
    path: '/v2/misc/media/thumbnail/pass/:id',
    description: 'Generate or retrieve a cached thumbnail image for a pass. Supports multiple sizes (SMALL, MEDIUM, LARGE). Thumbnails are cached and regenerated as needed. Hidden or deleted passes return 404.',
    category: 'MEDIA',
    parameters: {
      path: {
        id: 'number (required, 1-20 digits) - Pass ID'
      },
      query: {
        size: 'string (optional, default: "MEDIUM") - Thumbnail size: "SMALL" | "MEDIUM" | "LARGE"'
      }
    },
    responses: {
      '200': 'Returns PNG image',
      '404': 'Pass not found, deleted, or hidden',
      '500': 'Error generating image'
    }
  }
];

export default thumbnailsEndpoints;
