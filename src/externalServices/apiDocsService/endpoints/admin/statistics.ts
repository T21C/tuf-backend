import { EndpointDefinition } from '../../services/DocumentationService.js';

const statisticsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/admin/statistics',
    description: 'Get admin statistics including unrated ratings count and pending submissions',
    category: 'ADMIN',
    requiresAuth: true,
    responses: {
      '200': 'Statistics object with unrated ratings, pending level/pass submissions counts',
      '401': 'User not authenticated',
      '500': 'Failed to fetch statistics'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/statistics/ratings-per-user',
    description: 'Get rating statistics per user with date range filtering and pagination',
    category: 'ADMIN',
    requiresAuth: false,
    parameters: {
      query: {
        startDate: 'string (optional) - Start date for filtering (defaults to 7 days ago)',
        endDate: 'string (optional) - End date for filtering',
        page: 'number (optional, default: 1) - Page number',
        limit: 'number (optional, default: 20) - Results per page'
      }
    },
    responses: {
      '200': 'Paginated list of users with rating counts, average ratings per day, and overall statistics',
      '400': 'Invalid date format',
      '500': 'Failed to fetch ratings per user'
    }
  }
];

export default statisticsEndpoints;
