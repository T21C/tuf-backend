import {Router, type Request, type Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {standardErrorResponses500} from '@/server/schemas/common.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {KeyboardSetupError} from '@/misc/utils/keyboards/types.js';
import {
  getKeyboardCatalog,
  listCurrentKeybinds,
  parseFormFactorQuery,
} from '@/server/services/keyboards/keyboardSetupService.js';

const router: Router = Router();

function sendError(res: Response, error: unknown, label: string) {
  if (error instanceof KeyboardSetupError) {
    return res.status(error.status).json({error: error.message});
  }
  logger.error(label, error);
  return res.status(500).json({
    error: 'Keyboard catalog request failed',
    details: error instanceof Error ? error.message : String(error),
  });
}

router.get(
  '/catalog',
  ApiDoc({
    operationId: 'v3GetKeyboardCatalog',
    summary: 'Keyboard geometry, product, and switch catalog',
    tags: ['Database', 'Keyboards', 'v3'],
    responses: {200: {description: 'Catalog'}, ...standardErrorResponses500},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await getKeyboardCatalog());
    } catch (error) {
      return sendError(res, error, '[v3 GET /keyboards/catalog]');
    }
  },
);

router.get(
  '/current',
  ApiDoc({
    operationId: 'v3GetCurrentKeyboardBinds',
    summary: 'Current public player keybinds',
    description:
      'Flat list of current key-count binds for players who currently show the keyboards profile module. Intended as the source of truth for third-party viewers.',
    tags: ['Database', 'Keyboards', 'v3'],
    query: {
      limit: {schema: {type: 'string'}},
      offset: {schema: {type: 'string'}},
      formFactor: {schema: {type: 'string'}},
      keyCount: {schema: {type: 'string'}},
    },
    responses: {200: {description: 'Current keybinds'}, ...standardErrorResponses500},
  }),
  async (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit);
      const offset = Number(req.query.offset);
      const keyCount = req.query.keyCount == null || req.query.keyCount === ''
        ? undefined
        : Number(req.query.keyCount);
      return res.json(
        await listCurrentKeybinds({
          limit: Number.isFinite(limit) ? limit : undefined,
          offset: Number.isFinite(offset) ? offset : undefined,
          formFactor: parseFormFactorQuery(req.query.formFactor),
          keyCount: Number.isInteger(keyCount) ? keyCount : undefined,
        }),
      );
    } catch (error) {
      return sendError(res, error, '[v3 GET /keyboards/current]');
    }
  },
);

export default router;
