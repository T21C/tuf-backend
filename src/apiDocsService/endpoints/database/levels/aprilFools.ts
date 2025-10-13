import { EndpointDefinition } from '../../../services/DocumentationService.js';

const aprilFoolsEndpoints: EndpointDefinition[] = [
  {
    method: 'PUT',
    path: '/v2/database/levels/:id/difficulty',
    description: 'Update level difficulty with timeout restrictions (April Fools feature)',
    category: 'LEVELS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        diffId: 'integer (required) - New difficulty ID',
        baseScore: 'integer (optional) - New base score',
        publicComments: 'string (optional) - Public comments'
      }
    },
    responses: {
      '200': 'Level difficulty updated successfully',
      '401': 'Unauthorized',
      '400': 'Invalid level ID or difficulty ID',
      '404': 'Level or difficulty not found',
      '727': 'April fools over, roulette is disabled',
      '500': 'Failed to update level difficulty'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/:id/timeout',
    description: 'Update level difficulty with individual level timeout (April Fools feature)',
    category: 'LEVELS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        diffId: 'integer (required) - New difficulty ID',
        baseScore: 'integer (optional) - New base score',
        publicComments: 'string (optional) - Public comments'
      }
    },
    responses: {
      '200': 'Level updated successfully',
      '401': 'Unauthorized',
      '727': 'April fools over, roulette is disabled',
      '500': 'Failed to update level'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/all-levels',
    description: 'Get all levels for the slot machine feature with timeout checking (April Fools feature)',
    category: 'LEVELS',
    responses: {
      '200': 'Slot machine levels or timeout information',
      '727': 'April fools over, roulette is disabled',
      '500': 'Failed to fetch slot machine levels'
    }
  }
];

export default aprilFoolsEndpoints;
