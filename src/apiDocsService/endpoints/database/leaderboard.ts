import { EndpointDefinition } from '../../services/DocumentationService.js';

const leaderboardEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/leaderboard',
    method: 'GET',
    category: 'PLAYERS',
    description: 'Get leaderboard with various sorting and filtering options',
    parameters: {
      query: {
        sortBy: 'Sort field (default: rankedScore)',
        order: 'Sort order: asc, desc (default: desc)',
        showBanned: 'Show banned players: show, hide, only (default: show)',
        query: 'Search query or Discord ID/username with #/@ prefix',
        offset: 'Pagination offset (default: 0)',
        limit: 'Results per page (default: 30, max: 100)'
      }
    },
    responses: {
      '200': 'Leaderboard results with count and players',
      '400': 'Invalid sortBy option',
      '500': 'Failed to fetch leaderboard'
    }
  }
];

export default leaderboardEndpoints; 