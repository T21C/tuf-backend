import { EndpointDefinition } from '../../../services/DocumentationService.js';

const aliasesEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/levels/:id/aliases',
    description: 'Get all aliases for a specific level',
    category: 'LEVELS',
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'List of level aliases',
      '400': 'Invalid level ID',
      '500': 'Failed to fetch level aliases'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/:id/aliases',
    description: 'Add new alias(es) for a level with optional propagation to other levels',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        field: 'string (required) - Field to create alias for (song or artist)',
        alias: 'string (required) - Alias text',
        matchType: 'string (optional, default: exact) - Match type for propagation (exact or partial)',
        propagate: 'boolean (optional, default: false) - Whether to propagate alias to other levels'
      }
    },
    responses: {
      '200': 'Alias(es) added successfully',
      '400': 'Invalid field or alias',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to add level alias'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/:levelId/aliases/:aliasId',
    description: 'Update an existing level alias',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'integer (required) - Level ID',
        aliasId: 'integer (required) - Alias ID'
      },
      body: {
        alias: 'string (required) - New alias text'
      }
    },
    responses: {
      '200': 'Alias updated successfully',
      '400': 'Invalid ID or alias is required',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Alias not found',
      '500': 'Failed to update level alias'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/:levelId/aliases/:aliasId',
    description: 'Delete a level alias',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'integer (required) - Level ID',
        aliasId: 'integer (required) - Alias ID'
      }
    },
    responses: {
      '200': 'Alias deleted successfully',
      '400': 'Invalid ID',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Alias not found',
      '500': 'Failed to delete level alias'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/alias-propagation-count/:levelId',
    description: 'Get count of levels that would be affected by alias propagation',
    category: 'LEVELS',
    parameters: {
      path: {
        levelId: 'integer (required) - Level ID'
      },
      query: {
        field: 'string (required) - Field to check propagation for (song or artist)',
        matchType: 'string (optional, default: exact) - Match type for propagation'
      }
    },
    responses: {
      '200': 'Propagation count information',
      '400': 'Invalid field or level ID',
      '404': 'Level not found',
      '500': 'Failed to get alias propagation count'
    }
  }
];

export default aliasesEndpoints;
