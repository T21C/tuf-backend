import { EndpointDefinition } from '../../../services/DocumentationService.js';

const modificationEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/passes/:id',
    method: 'PUT',
    category: 'PASSES',
    description: 'Update pass details including judgements, accuracy, and score calculations',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Pass ID (number)'
      },
      body: {
        levelId: 'Level ID (optional)',
        vidUploadTime: 'Video upload timestamp (optional)',
        speed: 'Playback speed (optional)',
        feelingRating: 'Feeling rating (optional)',
        vidTitle: 'Video title (optional)',
        videoLink: 'Video link (optional)',
        is12K: '12K flag (optional)',
        is16K: '16K flag (optional)',
        isNoHoldTap: 'No hold tap flag (optional)',
        accuracy: 'Accuracy value (optional)',
        scoreV2: 'Score V2 value (optional)',
        isDeleted: 'Deleted flag (optional)',
        judgements: 'Judgement object (optional)',
        playerId: 'Player ID (optional)',
        isAnnounced: 'Announced flag (optional)',
        isDuplicate: 'Duplicate flag (optional)'
      }
    },
    responses: {
      '200': 'Updated pass object with all related data',
      '404': 'Pass not found',
      '500': 'Failed to update pass'
    }
  },
  {
    path: '/v2/database/passes/:id',
    method: 'DELETE',
    category: 'PASSES',
    description: 'Soft delete a pass (mark as deleted)',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Pass ID (number)'
      }
    },
    responses: {
      '200': 'Success message with deleted pass data',
      '404': 'Pass not found',
      '500': 'Failed to delete pass'
    }
  },
  {
    path: '/v2/database/passes/:id/restore',
    method: 'PATCH',
    category: 'PASSES',
    description: 'Restore a soft-deleted pass',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Pass ID (number)'
      }
    },
    responses: {
      '200': 'Success message with restored pass data',
      '404': 'Pass not found',
      '500': 'Failed to restore pass'
    }
  }
];

export default modificationEndpoints; 