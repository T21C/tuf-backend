import { EndpointDefinition } from '../../../services/DocumentationService.js';

const searchEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/passes/byId/:id',
    method: 'GET',
    category: 'PASSES',
    description: 'Get pass by ID with detailed information',
    parameters: {
      path: {
        id: 'Pass ID (number)'
      }
    },
    responses: {
      '200': 'Pass object with player, level, difficulty, and judgements data',
      '400': 'Invalid pass ID',
      '500': 'Failed to fetch pass'
    }
  },
  {
    path: '/v2/database/passes/:id',
    method: 'GET',
    category: 'PASSES',
    description: 'Get pass details using PlayerStatsService',
    parameters: {
      path: {
        id: 'Pass ID (number)'
      }
    },
    responses: {
      '200': 'Pass details object',
      '400': 'Invalid pass ID',
      '404': 'Pass not found',
      '500': 'Failed to fetch pass'
    }
  },
  {
    path: '/v2/database/passes/level/:levelId',
    method: 'GET',
    category: 'PASSES',
    description: 'Get all passes for a specific level',
    parameters: {
      path: {
        levelId: 'Level ID (number)'
      }
    },
    responses: {
      '200': 'Array of pass objects with player and judgement data',
      '404': 'Level not found',
      '500': 'Failed to fetch passes'
    }
  },
  {
    path: '/v2/database/passes',
    method: 'GET',
    category: 'PASSES',
    description: 'Search passes with various filters using Elasticsearch',
    parameters: {
      query: {
        deletedFilter: 'Filter for deleted passes (optional)',
        minDiff: 'Minimum difficulty filter (optional)',
        maxDiff: 'Maximum difficulty filter (optional)',
        keyFlag: 'Key flag filter (optional)',
        levelId: 'Filter by level ID (optional)',
        player: 'Filter by player name (optional)',
        specialDifficulties: 'Special difficulties filter (optional)',
        query: 'Search query text (optional)',
        offset: 'Pagination offset (default: 0)',
        limit: 'Pagination limit (default: 30)',
        sort: 'Sort order (optional)'
      }
    },
    responses: {
      '200': 'Search results with count and pass objects',
      '500': 'Failed to fetch passes'
    }
  }
];

export default searchEndpoints; 