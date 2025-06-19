import { EndpointDefinition } from '../../services/DocumentationService.js';

const playersEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/players',
    method: 'GET',
    category: 'PLAYERS',
    description: 'Get all players leaderboard',
    responses: {
      '200': 'Array of players with stats',
      '500': 'Failed to fetch players'
    }
  },
  {
    path: '/v2/database/players/:id',
    method: 'GET',
    category: 'PLAYERS',
    description: 'Get player details by ID',
    parameters: {
      path: {
        id: 'Player ID (number)'
      }
    },
    responses: {
      '200': 'Player object with enriched data and stats',
      '404': 'Player not found',
      '500': 'Failed to fetch player'
    }
  },
  {
    path: '/v2/database/players/search/:name',
    method: 'GET',
    category: 'PLAYERS',
    description: 'Search players by name',
    parameters: {
      path: {
        name: 'Player name to search'
      }
    },
    responses: {
      '200': 'Array of matching players with stats',
      '500': 'Failed to search players'
    }
  },
  {
    path: '/v2/database/players/:userId/discord',
    method: 'PUT',
    category: 'PLAYERS',
    description: 'Update player Discord information',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        userId: 'Player ID (number)'
      },
      body: {
        id: 'Discord ID (required)',
        username: 'Discord username (required)',
        avatar: 'Discord avatar (required)'
      }
    },
    responses: {
      '200': 'Discord info updated successfully',
      '404': 'Player not found',
      '409': 'Discord account already linked',
      '500': 'Failed to update player discord info'
    }
  },
  {
    path: '/v2/database/players/:id/discord',
    method: 'DELETE',
    category: 'PLAYERS',
    description: 'Remove Discord information from player',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Player ID (number)'
      }
    },
    responses: {
      '200': 'Discord info removed successfully',
      '404': 'Player not found',
      '500': 'Failed to remove player discord info'
    }
  },
  {
    path: '/v2/database/players/create',
    method: 'POST',
    category: 'PLAYERS',
    description: 'Create a new player',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        name: 'Player name (required)'
      }
    },
    responses: {
      '201': 'Player created successfully',
      '409': 'Player already exists',
      '500': 'Failed to create player'
    }
  },
  {
    path: '/v2/database/players/:id/discord/:discordId',
    method: 'GET',
    category: 'PLAYERS',
    description: 'Get Discord user information',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Player ID (number)',
        discordId: 'Discord ID (number)'
      }
    },
    responses: {
      '200': 'Discord user information',
      '404': 'Discord user not found',
      '500': 'Failed to fetch Discord user'
    }
  },
  {
    path: '/v2/database/players/:id/discord/:discordId',
    method: 'PUT',
    category: 'PLAYERS',
    description: 'Update player Discord information with specific Discord ID',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Player ID (number)',
        discordId: 'Discord ID (number)'
      },
      body: {
        username: 'Discord username (required)',
        avatar: 'Discord avatar (required)'
      }
    },
    responses: {
      '200': 'Discord info updated successfully',
      '404': 'Player not found',
      '500': 'Failed to update Discord info'
    }
  },
  {
    path: '/v2/database/players/:id/name',
    method: 'PUT',
    category: 'PLAYERS',
    description: 'Update player name',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Player ID (number)'
      },
      body: {
        name: 'New player name (required)'
      }
    },
    responses: {
      '200': 'Player name updated successfully',
      '400': 'Invalid name',
      '404': 'Player not found',
      '409': 'Name already taken',
      '500': 'Failed to update player name'
    }
  },
  {
    path: '/v2/database/players/:id/country',
    method: 'PUT',
    category: 'PLAYERS',
    description: 'Update player country',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Player ID (number)'
      },
      body: {
        country: 'Country code (2 characters, required)'
      }
    },
    responses: {
      '200': 'Player country updated successfully',
      '400': 'Invalid country code',
      '404': 'Player not found',
      '500': 'Failed to update player country'
    }
  },
  {
    path: '/v2/database/players/:id/ban',
    method: 'PATCH',
    category: 'PLAYERS',
    description: 'Ban or unban a player',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Player ID (number)'
      },
      body: {
        isBanned: 'Ban status (boolean, required)'
      }
    },
    responses: {
      '200': 'Player ban status updated successfully',
      '404': 'Player not found',
      '500': 'Failed to update player ban status'
    }
  },
  {
    path: '/v2/database/players/:id/pause-submissions',
    method: 'PATCH',
    category: 'PLAYERS',
    description: 'Pause or resume player submissions',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Player ID (number)'
      },
      body: {
        isSubmissionsPaused: 'Pause status (boolean, required)'
      }
    },
    responses: {
      '200': 'Player submission pause status updated successfully',
      '404': 'Player not found',
      '500': 'Failed to update player submission pause status'
    }
  },
  {
    path: '/v2/database/players/:id/merge',
    method: 'POST',
    category: 'PLAYERS',
    description: 'Merge two players',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Source player ID (number)'
      },
      body: {
        targetPlayerId: 'Target player ID (number, required)'
      }
    },
    responses: {
      '200': 'Players merged successfully',
      '404': 'One or both players not found',
      '500': 'Failed to merge players'
    }
  },
  {
    path: '/v2/database/players/request',
    method: 'POST',
    category: 'PLAYERS',
    description: 'Request a new player profile',
    requiresAuth: true,
    parameters: {
      body: {
        name: 'Player name (required)',
        discordId: 'Discord ID (required)',
        country: 'Country code (required)'
      }
    },
    responses: {
      '201': 'Player profile created successfully',
      '400': 'Missing required fields',
      '409': 'Player with this name already exists',
      '500': 'Failed to create player profile'
    }
  },
  {
    path: '/v2/database/players/:playerId/modifiers',
    method: 'GET',
    category: 'PLAYERS',
    description: 'Get active modifiers for a player',
    requiresAuth: true,
    responses: {
      '200': 'Player modifiers with probabilities and cooldown',
      '727': 'April fools over, modifiers are disabled',
      '500': 'Failed to fetch modifiers'
    }
  },
  {
    path: '/v2/database/players/modifiers/generate',
    method: 'POST',
    category: 'PLAYERS',
    description: 'Generate a new random modifier for a player',
    requiresAuth: true,
    parameters: {
      body: {
        targetPlayerId: 'Target player ID (number, required)'
      }
    },
    responses: {
      '200': 'Modifier generated successfully',
      '400': 'Target player ID is required or generation failed',
      '403': 'Player ID not found',
      '429': 'Spin cooldown active',
      '727': 'April fools over, modifiers are disabled',
      '500': 'Failed to generate modifier'
    }
  }
];

export default playersEndpoints; 