import { EndpointDefinition } from '../../services/DocumentationService.js';

const submissionsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/admin/submissions/levels',
    description: 'Get all level submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of level submissions',
      '500': 'Failed to fetch level submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/levels/pending',
    description: 'Get pending level submissions with creator and team request data',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pending level submissions with creator/team statistics',
      '500': 'Failed to fetch pending level submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/passes',
    description: 'Get all pass submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pass submissions with judgements and flags',
      '500': 'Failed to fetch pass submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/passes/pending',
    description: 'Get pending pass submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pending pass submissions with player, level, and difficulty data',
      '500': 'Failed to fetch pending pass submissions'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/approve',
    description: 'Approve level submission and create level with rating',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Submission approved, level and rating created successfully',
      '400': 'All creators must be assigned or marked as new',
      '404': 'Submission or referenced creator/team not found',
      '500': 'Failed to process level submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/decline',
    description: 'Decline level submission and clean up CDN files',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Submission declined successfully',
      '404': 'Submission not found',
      '500': 'Failed to process level submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/passes/:id/approve',
    description: 'Approve pass submission and create pass with judgements',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Pass submission approved successfully with pass data',
      '404': 'Submission, level, or difficulty not found',
      '500': 'Failed to process pass submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/passes/:id/decline',
    description: 'Decline pass submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Pass submission rejected successfully',
      '500': 'Failed to decline pass submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/passes/:id/assign-player',
    description: 'Assign player to pass submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        playerId: 'number (required) - Player ID to assign'
      }
    },
    responses: {
      '200': 'Player assigned successfully',
      '404': 'Submission not found',
      '500': 'Failed to assign player'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/auto-approve/passes',
    description: 'Auto-approve all pending pass submissions with assigned players',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'Auto-approval completed with results for each submission',
      '500': 'Failed to auto-approve submissions'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/profiles',
    description: 'Update creator and team request profiles for level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        creatorRequests: 'array (optional) - Updated creator requests',
        teamRequestData: 'object (optional) - Updated team request data'
      }
    },
    responses: {
      '200': 'Submission profiles updated successfully',
      '404': 'Submission not found',
      '500': 'Failed to update submission profiles'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/assign-creator',
    description: 'Assign existing creator to level submission credit request',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        creatorId: 'number (required) - Creator ID to assign',
        role: 'string (required) - Creator role (charter or vfxer)',
        creditRequestId: 'number (required) - Credit request ID'
      }
    },
    responses: {
      '200': 'Creator assigned successfully',
      '400': 'Missing required fields',
      '404': 'Submission, creator, or credit request not found',
      '500': 'Failed to assign creator'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/creators',
    description: 'Create new creator/team and assign to level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        name: 'string (required) - Creator/team name',
        aliases: 'array (optional) - Team aliases (for team role only)',
        role: 'string (required) - Role (charter, vfxer, or team)',
        creditRequestId: 'number (required) - Credit request ID'
      }
    },
    responses: {
      '200': 'Creator/team created and assigned successfully',
      '400': 'Missing required fields',
      '404': 'Submission not found',
      '500': 'Failed to create and assign creator/team'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/creator-requests',
    description: 'Add new creator request to level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        role: 'string (required) - Creator role (charter, vfxer, or team)'
      }
    },
    responses: {
      '200': 'Creator request added successfully',
      '400': 'Role is required',
      '404': 'Submission not found',
      '500': 'Failed to add creator request'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/submissions/levels/:id/creator-requests/:requestId',
    description: 'Remove creator request from level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID',
        requestId: 'number (required) - Request ID'
      }
    },
    responses: {
      '200': 'Creator request removed successfully',
      '400': 'Cannot remove the last charter',
      '404': 'Submission or request not found',
      '500': 'Failed to remove creator request'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/song',
    description: 'Change song selection for level submission (existing song or new request)',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        songId: 'number (optional) - Existing song ID',
        isNewRequest: 'boolean (optional) - Create new song request',
        songName: 'string (optional) - Song name for new request',
        requiresEvidence: 'boolean (optional) - Whether evidence is required for new request'
      }
    },
    responses: {
      '200': 'Song selection updated successfully',
      '404': 'Submission or song not found',
      '500': 'Failed to change song'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/artist',
    description: 'Change artist selection for level submission (existing artist or new request)',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        artistId: 'number (optional) - Existing artist ID',
        artistRequestId: 'number (optional) - Artist request ID to update',
        isNewRequest: 'boolean (optional) - Create new artist request',
        artistName: 'string (optional) - Artist name for new request',
        requiresEvidence: 'boolean (optional) - Whether evidence is required',
        verificationState: 'string (optional) - Verification state for new request'
      }
    },
    responses: {
      '200': 'Artist selection updated successfully',
      '400': 'Cannot modify artists when existing song is selected',
      '404': 'Submission or artist not found',
      '500': 'Failed to change artist'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/evidence',
    description: 'Upload evidence images for submission (up to 10 files)',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        type: 'string (required) - Evidence type: "song" or "artist"',
        requestId: 'number (optional) - Request ID for artist/song request',
        evidence: 'file[] (required) - Evidence image files (max 10)'
      }
    },
    responses: {
      '200': 'Evidence uploaded successfully',
      '400': 'No files uploaded or too many files',
      '500': 'Failed to upload evidence'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/submissions/levels/:id/evidence/:evidenceId',
    description: 'Delete evidence image from submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID',
        evidenceId: 'number (required) - Evidence ID'
      }
    },
    responses: {
      '200': 'Evidence deleted successfully',
      '500': 'Failed to delete evidence'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/levels/:id/evidence',
    description: 'Get all evidence for a submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'List of evidence images',
      '500': 'Failed to fetch evidence'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/assign-song',
    description: 'Assign existing song to submission and auto-populate artists from song credits',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        songId: 'number (required) - Song ID to assign'
      }
    },
    responses: {
      '200': 'Song assigned successfully with auto-populated artists',
      '400': 'Song ID is required',
      '404': 'Submission or song not found',
      '500': 'Failed to assign song'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/assign-artist',
    description: 'Assign existing artist to submission request (adds to array)',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        artistId: 'number (required) - Artist ID to assign'
      }
    },
    responses: {
      '200': 'Artist assigned successfully',
      '400': 'Cannot modify artists when existing song is selected or artist already added',
      '404': 'Submission or artist not found',
      '500': 'Failed to assign artist'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/songs',
    description: 'Create new song and assign to submission in one step',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        name: 'string (required) - Song name',
        aliases: 'array (optional) - Song aliases',
        songRequestId: 'number (optional) - Song request ID to update'
      }
    },
    responses: {
      '200': 'Song created and assigned successfully',
      '400': 'Song name is required',
      '404': 'Submission not found',
      '500': 'Failed to create and assign song'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/artists',
    description: 'Create new artist and assign to submission in one step (adds to array)',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        name: 'string (required) - Artist name',
        aliases: 'array (optional) - Artist aliases',
        artistRequestId: 'number (optional) - Artist request ID to update'
      }
    },
    responses: {
      '200': 'Artist created and assigned successfully',
      '400': 'Cannot modify artists when existing song is selected or artist name is required',
      '404': 'Submission not found',
      '500': 'Failed to create and assign artist'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/song-requests',
    description: 'Add new song request to submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        requiresEvidence: 'boolean (optional) - Whether evidence is required (default: true)'
      }
    },
    responses: {
      '200': 'Song request added successfully',
      '404': 'Submission not found',
      '500': 'Failed to create song request'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/artist-requests',
    description: 'Add new artist request to submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        verificationState: 'string (optional) - Verification state for new request'
      }
    },
    responses: {
      '200': 'Artist request added successfully',
      '400': 'Cannot add artist requests when existing song is selected',
      '404': 'Submission not found',
      '500': 'Failed to create artist request'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/submissions/levels/:id/artist-requests/:requestId',
    description: 'Delete artist request from submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID',
        requestId: 'number (required) - Artist request ID'
      }
    },
    responses: {
      '200': 'Artist request deleted successfully',
      '400': 'Cannot remove artist requests when existing song is selected',
      '404': 'Submission or artist request not found',
      '500': 'Failed to delete artist request'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/suffix',
    description: 'Update suffix field for level submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        suffix: 'string (optional) - Suffix text (trimmed, null if empty)'
      }
    },
    responses: {
      '200': 'Suffix updated successfully (returns only updated suffix field)',
      '404': 'Submission not found',
      '500': 'Failed to update suffix'
    }
  }
];

export default submissionsEndpoints;
