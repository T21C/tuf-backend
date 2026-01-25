import { EndpointDefinition } from '../../../services/DocumentationService.js';

const searchEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/levels',
    description: 'Search levels using Elasticsearch with various filters and sorting options',
    category: 'LEVELS',
    parameters: {
      query: {
        query: 'string (optional) - Search query string',
        pguRange: 'string (optional) - PGU range filter (comma-separated from,to)',
        specialDifficulties: 'string (optional) - Special difficulties filter (comma-separated)',
        sort: 'string (optional) - Sort order',
        offset: 'integer (optional, default: 0) - Pagination offset',
        limit: 'integer (optional, default: 30, max: 200) - Pagination limit',
        deletedFilter: 'string (optional) - Filter for deleted levels',
        clearedFilter: 'string (optional) - Filter for cleared levels',
        availableDlFilter: 'string (optional) - Filter for available download levels',
        curatedTypesFilter: 'string (optional) - Filter for curated levels: "only" (curated only), "hide" (non-curated only), "show" (all levels), or comma-separated curation type names',
        onlyMyLikes: 'boolean (optional) - Only return levels liked by current user'
      }
    },
    responses: {
      '200': 'Returns { results, hasMore, total } with matching levels and their indexed metadata',
      '500': 'Internal server error'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/byId/:id',
    description: 'Get basic level information by ID without detailed data',
    category: 'LEVELS',
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Returns a level record including difficulty, passes, aliases, credits, and team info',
      '400': 'Invalid level ID',
      '404': 'Level not found',
      '500': 'Failed to fetch level by ID'
    }
  },
  {
    method: 'HEAD',
    path: '/v2/database/levels/byId/:id',
    description: 'Check if a level exists and if the user has permission to access it',
    category: 'LEVELS',
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Level exists and user has permission',
      '400': 'Invalid level ID',
      '404': 'Level not found or deleted',
      '500': 'Internal server error'
    }
  },
  {
    method: 'HEAD',
    path: '/v2/database/levels/:id',
    description: 'Check if a level exists and if the user has permission to access it (for deleted levels)',
    category: 'LEVELS',
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Level exists and user has permission',
      '400': 'Invalid level ID',
      '403': 'Level is deleted and user is not super admin',
      '404': 'Level not found',
      '500': 'Internal server error'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/:id',
    description: 'Get detailed level information including passes, ratings, and user-specific data',
    category: 'LEVELS',
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
    },
    responses: {
      '200': 'Returns { level, ratings, votes?, rerateHistory, totalVotes, isLiked, isCleared, bpm, tilecount, accessCount, metadata }',
      '400': 'Invalid level ID',
      '404': 'Level not found',
      '500': 'Failed to fetch level'
    }
  }
];

export default searchEndpoints;
