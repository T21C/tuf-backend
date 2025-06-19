import { EndpointDefinition } from '../../services/DocumentationService.js';

export const mediaEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/media/thumbnails/:levelId/:size',
    category: 'MEDIA',
    description: 'Generate or retrieve thumbnail for a level',
    parameters: {
      path: {
        levelId: 'number (required) - Level ID',
        size: 'string (required) - Thumbnail size (SMALL, MEDIUM, LARGE)'
      }
    },
    responses: {
      '200': 'PNG thumbnail image',
      '400': 'Invalid level ID or size',
      '404': 'Level not found',
      '500': 'Server error generating thumbnail'
    },
    requiresAuth: false
  },
  {
    method: 'GET',
    path: '/media/wheel/:levelId',
    category: 'MEDIA',
    description: 'Generate or retrieve wheel image for a level',
    parameters: {
      path: {
        levelId: 'number (required) - Level ID'
      }
    },
    responses: {
      '200': 'PNG wheel image',
      '400': 'Invalid level ID',
      '404': 'Level not found',
      '500': 'Server error generating wheel'
    },
    requiresAuth: false
  },
  {
    method: 'GET',
    path: '/media/avatars/:userId',
    category: 'MEDIA',
    description: 'Get user avatar image',
    parameters: {
      path: {
        userId: 'string (required) - User ID'
      }
    },
    responses: {
      '200': 'Avatar image',
      '404': 'User or avatar not found',
      '500': 'Server error retrieving avatar'
    },
    requiresAuth: false
  },
  {
    method: 'GET',
    path: '/media/github/:username',
    category: 'MEDIA',
    description: 'Get GitHub user information and avatar',
    parameters: {
      path: {
        username: 'string (required) - GitHub username'
      }
    },
    responses: {
      '200': 'GitHub user information with avatar URL',
      '404': 'GitHub user not found',
      '500': 'Server error fetching GitHub data'
    },
    requiresAuth: false
  },
  {
    method: 'POST',
    path: '/media/process-avatar',
    category: 'MEDIA',
    description: 'Process and upload user avatar',
    parameters: {
      body: {
        avatar: 'file (required) - Avatar image file',
        userId: 'string (required) - User ID'
      }
    },
    responses: {
      '200': 'Avatar processing result with URL',
      '400': 'Invalid file or user ID',
      '500': 'Server error processing avatar'
    },
    requiresAuth: true
  }
]; 