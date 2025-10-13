import { EndpointDefinition } from '../../services/DocumentationService.js';

const statisticsEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/statistics',
    method: 'GET',
    category: 'UTILS',
    description: 'Get overall system statistics',
    responses: {
      '200': 'Comprehensive system statistics including overview, difficulties, and submissions',
      '500': 'Failed to fetch statistics'
    }
  },
  {
    path: '/v2/database/statistics/players',
    method: 'GET',
    category: 'PLAYERS',
    description: 'Get player statistics',
    responses: {
      '200': 'Player statistics including country stats and top passers',
      '500': 'Failed to fetch player statistics'
    }
  }
];

export default statisticsEndpoints;
