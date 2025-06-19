import { EndpointDefinition } from '../../services/DocumentationService.js';

const oauthEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/auth/oauth/discord',
    description: 'Initiate Discord OAuth login',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      query: {
        redirect: 'string (optional) - Redirect URL after authentication'
      }
    },
    responses: {
      '302': 'Redirects to Discord OAuth authorization page',
      '400': 'Invalid redirect URL'
    }
  },
  {
    method: 'GET',
    path: '/v2/auth/oauth/discord/callback',
    description: 'Handle Discord OAuth callback',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      query: {
        code: 'string (required) - Authorization code from Discord',
        state: 'string (optional) - State parameter for CSRF protection'
      }
    },
    responses: {
      '200': 'OAuth successful - Returns JWT token and user data',
      '400': 'Invalid authorization code',
      '401': 'OAuth authentication failed'
    }
  }
];

export default oauthEndpoints; 