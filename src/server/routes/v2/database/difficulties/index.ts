import { Router } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses500 } from '@/server/schemas/v2/database/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { getDifficultiesHash } from './shared.js';
import channels from './channels.js';
import roles from './roles.js';
import directives from './directives.js';
import tags from './tags.js';
import modification from './modification.js';

/**
 * Aggregates every difficulties-related subrouter under a single `/difficulties`
 * mount point and exposes two top-level utility routes (`GET /hash`,
 * `HEAD /verify-password`) that are too small to warrant their own module.
 *
 * Mount order matters in two places:
 *   - Bulk/literal routes (e.g. `/sort-orders`, `/verify-password`) sit ahead
 *     of any wildcard ID matcher in their respective files.
 *   - `modification` goes last because it owns the catch-all `PUT /:id`, which
 *     would otherwise shadow other subrouters' id-suffixed paths.
 *
 * `updateDifficultiesHash` is re-exported here so existing importers that
 * point at `@/server/routes/v2/database/difficulties/index.js` keep working
 * after the monolithic `difficulties.ts` file was split.
 */

const router: Router = Router();

router.get(
  '/hash',
  ApiDoc({
    operationId: 'getDifficultiesHash',
    summary: 'Difficulties hash',
    description: 'Get current hash of difficulties (for cache busting).',
    tags: ['Database', 'Difficulties'],
    responses: { 200: { description: 'Hash' }, ...standardErrorResponses500 },
  }),
  async (req, res) => {
    try {
      res.json({ hash: getDifficultiesHash() });
    } catch (error) {
      logger.error('Error fetching difficulties hash:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.head('/verify-password', Auth.superAdminPassword(), async (req, res) => {
  return res.status(200).send({});
});

router.use('/', channels);
router.use('/', roles);
router.use('/', directives);
router.use('/', tags);
router.use('/', modification);

export { updateDifficultiesHash } from './shared.js';

export default router;
