import {Router, type Request, type Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {KeyboardSetupError} from '@/misc/utils/keyboards/types.js';
import {
  createFormFactor,
  createGeometry,
  createProduct,
  createSwitchRow,
  deleteFormFactor,
  deleteGeometry,
  deleteProduct,
  deleteSwitchRow,
  getKeyboardCatalog,
  importGeometryFromKle,
  reorderFormFactors,
  updateFormFactor,
  updateGeometry,
  updateProduct,
  updateSwitchRow,
} from '@/server/services/keyboards/keyboardSetupService.js';

const router = Router();

function sendError(res: Response, error: unknown, label: string) {
  if (error instanceof KeyboardSetupError) {
    return res.status(error.status).json({error: error.message});
  }
  logger.error(label, error);
  return res.status(500).json({
    error: 'Failed to update keyboard catalog',
    details: error instanceof Error ? error.message : String(error),
  });
}

router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminGetKeyboardCatalog',
    summary: 'List keyboard geometries, products, switches, and form factors',
    tags: ['Admin', 'Keyboards'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Catalog'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.json(await getKeyboardCatalog());
    } catch (error) {
      return sendError(res, error, '[admin GET /keyboards]');
    }
  },
);

router.post('/form-factors', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await createFormFactor(req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin POST form-factors]');
  }
});

router.post('/form-factors/reorder', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await reorderFormFactors(req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin POST form-factors/reorder]');
  }
});

router.patch('/form-factors/:slug', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await updateFormFactor(String(req.params.slug), req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin PATCH form-factors]');
  }
});

router.delete('/form-factors/:slug', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await deleteFormFactor(String(req.params.slug)));
  } catch (error) {
    return sendError(res, error, '[admin DELETE form-factors]');
  }
});

router.post('/geometries', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await createGeometry(req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin POST geometries]');
  }
});

router.post('/geometries/import-kle', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await importGeometryFromKle(req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin POST import-kle]');
  }
});

router.post('/geometries/:id/import-kle', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await importGeometryFromKle(req.body ?? {}, Number(req.params.id)));
  } catch (error) {
    return sendError(res, error, '[admin POST geometry import-kle]');
  }
});

router.patch('/geometries/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await updateGeometry(Number(req.params.id), req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin PATCH geometries]');
  }
});

router.delete('/geometries/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await deleteGeometry(Number(req.params.id)));
  } catch (error) {
    return sendError(res, error, '[admin DELETE geometries]');
  }
});

router.post('/products', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await createProduct(req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin POST products]');
  }
});

router.patch('/products/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await updateProduct(Number(req.params.id), req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin PATCH products]');
  }
});

router.delete('/products/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await deleteProduct(Number(req.params.id)));
  } catch (error) {
    return sendError(res, error, '[admin DELETE products]');
  }
});

router.post('/switches', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await createSwitchRow(req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin POST switches]');
  }
});

router.patch('/switches/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await updateSwitchRow(Number(req.params.id), req.body ?? {}));
  } catch (error) {
    return sendError(res, error, '[admin PATCH switches]');
  }
});

router.delete('/switches/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    return res.json(await deleteSwitchRow(Number(req.params.id)));
  } catch (error) {
    return sendError(res, error, '[admin DELETE switches]');
  }
});

export default router;
