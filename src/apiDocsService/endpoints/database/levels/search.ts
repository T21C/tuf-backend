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
        onlyMyLikes: 'boolean (optional) - Only return levels liked by current user'
      }
    },
    responses: {
      '200': 'Search results with pagination information',
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
      '200': 'Level found with basic information',
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
    method: 'GET',
    path: '/v2/database/levels/:id',
    description: 'Get detailed level information including passes, ratings, and user-specific data',
    category: 'LEVELS',
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      query: {
        includeRatings: 'boolean (optional) - Include rating details in response'
      }
    },
    responses: {
      '200': 'Level found with detailed information',
      '400': 'Invalid level ID',
      '404': 'Level not found',
      '500': 'Failed to fetch level'
    }
  }
];

export default searchEndpoints; 