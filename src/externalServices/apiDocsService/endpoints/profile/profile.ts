import { EndpointDefinition } from '../../services/DocumentationService.js';

const profileEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/auth/profile/me',
    description: 'Get current user profile information',
    category: 'PLAYERS',
    requiresAuth: true,
    responses: {
      '200': 'User profile data including OAuth providers and player information',
      '401': 'User not authenticated'
    }
  },
  {
    method: 'PUT',
    path: '/v2/auth/profile/me',
    description: 'Update current user profile information',
    category: 'PLAYERS',
    requiresAuth: true,
    parameters: {
      body: {
        nickname: 'string (optional) - New nickname for the user',
        country: 'string (optional) - User country code'
      }
    },
    responses: {
      '200': 'Profile updated successfully - Returns updated user data',
      '400': 'Nickname already taken or username already taken',
      '401': 'User not authenticated',
      '429': 'Username change rate limit exceeded (24-hour cooldown)',
      '404': 'User not found after update',
      '500': 'Failed to update profile'
    }
  },
  {
    method: 'PUT',
    path: '/v2/auth/profile/password',
    description: 'Update user password',
    category: 'PLAYERS',
    requiresAuth: true,
    parameters: {
      body: {
        currentPassword: 'string (optional) - Current password (required if user has password)',
        newPassword: 'string (required) - New password to set'
      }
    },
    responses: {
      '200': 'Password updated successfully',
      '400': 'Current password is required or incorrect',
      '401': 'User not authenticated',
      '500': 'Failed to update password'
    }
  },
  {
    method: 'POST',
    path: '/v2/auth/profile/avatar',
    description: 'Upload user avatar image',
    category: 'MEDIA',
    requiresAuth: true,
    parameters: {
      body: {
        avatar: 'file (required) - Avatar image file (JPEG, PNG, WebP, max 5MB)'
      }
    },
    responses: {
      '200': 'Avatar uploaded successfully - Returns avatar URLs and file ID',
      '400': 'No file uploaded, invalid file type, or CDN error',
      '401': 'User not authenticated',
      '500': 'Failed to upload avatar'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/auth/profile/avatar',
    description: 'Remove user avatar',
    category: 'MEDIA',
    requiresAuth: true,
    responses: {
      '200': 'Avatar removed successfully',
      '400': 'No avatar to remove',
      '401': 'User not authenticated',
      '500': 'Failed to remove avatar'
    }
  }
];

export default profileEndpoints;
