import { EndpointDefinition } from '../../services/DocumentationService.js';

const usersEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/admin/users',
    description: 'Get all users with roles (raters and admins)',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    responses: {
      '200': 'List of users with roles',
      '500': 'Failed to fetch users'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/users/raters',
    description: 'Get all raters',
    category: 'ADMIN',
    requiresAuth: true,
    responses: {
      '200': 'List of raters',
      '500': 'Failed to fetch raters'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/users/curators',
    description: 'Get all curators',
    category: 'ADMIN',
    requiresAuth: true,
    responses: {
      '200': 'List of curators',
      '500': 'Failed to fetch curators'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/users/grant-role',
    description: 'Grant role to user',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      body: {
        discordId: 'string (required) - Discord ID of user',
        role: 'string (required) - Role to grant (RATER, CURATOR, HEAD_CURATOR, SUPER_ADMIN)'
      }
    },
    responses: {
      '200': 'Role granted successfully',
      '400': 'Invalid role or Discord ID',
      '404': 'User not found',
      '500': 'Failed to grant role'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/users/revoke-role',
    description: 'Revoke role from user',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      body: {
        discordId: 'string (required) - Discord ID of user',
        role: 'string (required) - Role to revoke'
      }
    },
    responses: {
      '200': 'Role revoked successfully',
      '400': 'Invalid role or Discord ID',
      '404': 'User not found',
      '500': 'Failed to revoke role'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/users/sync-discord',
    description: 'Update user Discord info',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      body: {
        discordId: 'string (required) - Discord ID',
        username: 'string (optional) - Discord username',
        avatar: 'string (optional) - Discord avatar hash'
      }
    },
    responses: {
      '200': 'Discord info updated successfully',
      '404': 'User not found',
      '500': 'Failed to update Discord info'
    }
  },
  {
    method: 'PATCH',
    path: '/v2/admin/users/:playerId/rating-ban',
    description: 'Toggle rating ban for user',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      path: {
        playerId: 'number (required) - Player ID'
      }
    },
    responses: {
      '200': 'Rating ban status updated',
      '404': 'User not found',
      '500': 'Failed to update rating ban status'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/users/check/:discordId',
    description: 'Check user roles by Discord ID',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        discordId: 'string (required) - Discord ID'
      }
    },
    responses: {
      '200': 'User roles information',
      '404': 'User not found',
      '500': 'Failed to check user roles'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/users/discord/:discordId',
    description: 'Get user by Discord ID',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        discordId: 'string (required) - Discord ID'
      }
    },
    responses: {
      '200': 'User information',
      '404': 'User not found',
      '500': 'Failed to fetch user'
    }
  }
];

export default usersEndpoints;
