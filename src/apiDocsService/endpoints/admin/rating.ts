import { EndpointDefinition } from '../../services/DocumentationService.js';

const ratingEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/admin/rating',
    description: 'Get all ratings',
    category: 'ADMIN',
    requiresAuth: true,
    responses: {
      '200': 'List of ratings',
      '500': 'Failed to fetch ratings'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/rating/:id',
    description: 'Update rating',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Rating ID'
      },
      body: {
        rating: 'number (required) - Rating value',
        comment: 'string (optional) - Rating comment'
      }
    },
    responses: {
      '200': 'Rating updated successfully',
      '400': 'Invalid rating data',
      '404': 'Rating not found',
      '500': 'Failed to update rating'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/rating/:id/detail/:userId',
    description: 'Delete rating detail',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Rating ID',
        userId: 'string (required) - User ID'
      }
    },
    responses: {
      '200': 'Rating detail deleted successfully',
      '404': 'Rating detail not found',
      '500': 'Failed to delete rating detail'
    }
  }
];

export default ratingEndpoints;
