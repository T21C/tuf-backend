import { EndpointDefinition } from '../../services/DocumentationService.js';

const referencesEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/references',
    method: 'GET',
    category: 'LEVELS',
    description: 'Get all references grouped by difficulty',
    responses: {
      '200': 'Array of difficulties with their reference levels',
      '500': 'Failed to fetch references'
    }
  },
  {
    path: '/v2/database/references/difficulty/:difficultyId',
    method: 'GET',
    category: 'LEVELS',
    description: 'Get references for a specific difficulty',
    parameters: {
      path: {
        difficultyId: 'Difficulty ID (number)'
      }
    },
    responses: {
      '200': 'Difficulty with reference levels',
      '404': 'Difficulty not found',
      '500': 'Failed to fetch references'
    }
  },
  {
    path: '/v2/database/references/level/:levelId',
    method: 'GET',
    category: 'LEVELS',
    description: 'Get references by level ID',
    parameters: {
      path: {
        levelId: 'Level ID (number)'
      }
    },
    responses: {
      '200': 'Array of references for the level',
      '500': 'Failed to fetch references'
    }
  },
  {
    path: '/v2/database/references',
    method: 'POST',
    category: 'LEVELS',
    description: 'Create a new reference',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        difficultyId: 'Difficulty ID (number, required)',
        levelId: 'Level ID (number, required)',
        type: 'Reference type (string, required)'
      }
    },
    responses: {
      '201': 'Reference created successfully',
      '409': 'Reference already exists',
      '500': 'Failed to create reference'
    }
  },
  {
    path: '/v2/database/references/:id',
    method: 'PUT',
    category: 'LEVELS',
    description: 'Update a reference',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Reference ID (number)'
      },
      body: {
        difficultyId: 'Difficulty ID (number, required)',
        levelId: 'Level ID (number, required)',
        type: 'Reference type (string, required)'
      }
    },
    responses: {
      '200': 'Reference updated successfully',
      '404': 'Reference not found',
      '409': 'Reference with these IDs already exists',
      '500': 'Failed to update reference'
    }
  },
  {
    path: '/v2/database/references/:id',
    method: 'DELETE',
    category: 'LEVELS',
    description: 'Delete a reference',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Reference ID (number)'
      }
    },
    responses: {
      '200': 'Reference deleted successfully',
      '404': 'Reference not found',
      '500': 'Failed to delete reference'
    }
  },
  {
    path: '/v2/database/references/bulk/:difficultyId',
    method: 'PUT',
    category: 'LEVELS',
    description: 'Bulk update references for a difficulty',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        difficultyId: 'Difficulty ID (number)'
      },
      body: {
        references: 'Array of reference objects with levelId and type'
      }
    },
    responses: {
      '200': 'Bulk update result with counts',
      '500': 'Failed to bulk update references'
    }
  }
];

export default referencesEndpoints; 