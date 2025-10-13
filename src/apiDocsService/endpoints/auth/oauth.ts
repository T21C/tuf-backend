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
  },
  {
    method: 'POST',
    path: '/v2/auth/oauth/callback/:provider',
    description: 'Handle OAuth callback from provider',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      path: {
        provider: 'string (required) - OAuth provider (discord, etc.)'
      },
      body: {
        code: 'string (required) - Authorization code from provider',
        state: 'string (optional) - State parameter for CSRF protection'
      }
    },
    responses: {
      '200': 'OAuth successful - Returns JWT token and user data',
      '400': 'Invalid authorization code or provider',
      '401': 'OAuth authentication failed'
    }
  },
  {
    method: 'GET',
    path: '/v2/auth/oauth/me',
    description: 'Get current user OAuth profile information',
    category: 'AUTH',
    requiresAuth: true,
    responses: {
      '200': 'OAuth profile data for authenticated user',
      '401': 'User not authenticated'
    }
  },
  {
    method: 'GET',
    path: '/v2/auth/oauth/login/:provider',
    description: 'Initiate OAuth login with provider',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      path: {
        provider: 'string (required) - OAuth provider (discord, etc.)'
      },
      query: {
        redirect: 'string (optional) - Redirect URL after authentication'
      }
    },
    responses: {
      '302': 'Redirects to provider OAuth authorization page',
      '400': 'Invalid provider or redirect URL'
    }
  },
  {
    method: 'GET',
    path: '/v2/auth/oauth/link/:provider',
    description: 'Initiate OAuth provider linking to existing account',
    category: 'AUTH',
    requiresAuth: true,
    parameters: {
      path: {
        provider: 'string (required) - OAuth provider (discord, etc.)'
      }
    },
    responses: {
      '302': 'Redirects to provider OAuth authorization page for linking',
      '400': 'Invalid provider',
      '401': 'User not authenticated'
    }
  },
  {
    method: 'POST',
    path: '/v2/auth/oauth/link/:provider',
    description: 'Link OAuth provider to current user account',
    category: 'AUTH',
    requiresAuth: true,
    parameters: {
      path: {
        provider: 'string (required) - OAuth provider (discord, etc.)'
      },
      body: {
        code: 'string (required) - Authorization code from provider'
      }
    },
    responses: {
      '200': 'Provider linked successfully',
      '400': 'Invalid authorization code or provider already linked',
      '401': 'User not authenticated'
    }
  },
  {
    method: 'POST',
    path: '/v2/auth/oauth/unlink/:provider',
    description: 'Unlink OAuth provider from current user account',
    category: 'AUTH',
    requiresAuth: true,
    parameters: {
      path: {
        provider: 'string (required) - OAuth provider (discord, etc.)'
      }
    },
    responses: {
      '200': 'Provider unlinked successfully',
      '400': 'Provider not linked or invalid provider',
      '401': 'User not authenticated'
    }
  },
  {
    method: 'POST',
    path: '/v2/auth/oauth/refresh/:provider',
    description: 'Refresh OAuth token for provider',
    category: 'AUTH',
    requiresAuth: true,
    parameters: {
      path: {
        provider: 'string (required) - OAuth provider (discord, etc.)'
      }
    },
    responses: {
      '200': 'Token refreshed successfully',
      '400': 'Invalid provider or refresh failed',
      '401': 'User not authenticated'
    }
  }
];

export default oauthEndpoints;
