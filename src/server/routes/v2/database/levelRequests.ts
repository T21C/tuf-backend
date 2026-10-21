import {Router, Request, Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {Auth} from '@/server/middleware/auth.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {LevelRequestError} from '@/server/services/requests/levelRequestService.js';
import {
  createLevelRequest,
  getLevelRequestForViewer,
  levelRequestEligibility,
  countOpenLevelRequests,
  listLevelRequests,
  listOwnLevelRequests,
  applyLevelRequestAction,
  postLevelRequestDiscord,
  updateLevelRequestStaff,
  updateOwnLevelRequest,
  withdrawLevelRequest,
} from '@/server/services/requests/levelRequestService.js';

const router = Router();

function viewer(req: Request) {
  const user = req.user;
  if (!user?.id) return null;
  return {
    id: user.id,
    playerId: user.playerId ?? null,
    permissionFlags: user.permissionFlags,
  };
}

function sendError(res: Response, error: unknown, fallback: string) {
  if (error instanceof LevelRequestError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details ? {details: error.details} : {}),
    });
  }
  logger.error(fallback, error);
  return res.status(500).json({error: fallback});
}

router.get(
  '/eligibility/:levelId([0-9]+)',
  Auth.verified(),
  ApiDoc({
    operationId: 'getLevelRequestEligibility',
    summary: 'Whether the current user can submit each request type for a level',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Eligibility by type'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const result = await levelRequestEligibility(user, Number(req.params.levelId));
      return res.json(result);
    } catch (error) {
      return sendError(res, error, 'Failed to check request eligibility');
    }
  },
);

router.get(
  '/mine',
  Auth.verified(),
  ApiDoc({
    operationId: 'listOwnLevelRequests',
    summary: 'List the current user level requests',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Paged requests'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const page = await listOwnLevelRequests(user, req.query as Record<string, unknown>);
      return res.json(page);
    } catch (error) {
      return sendError(res, error, 'Failed to list requests');
    }
  },
);

router.get(
  '/for-rating/:ratingId([0-9]+)',
  Auth.verified(),
  ApiDoc({
    operationId: 'getLevelRequestForRating',
    summary: 'Request linked to a rating, if one exists',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Linked request or null'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const {levelRequestForRating} = await import('@/server/services/requests/levelRequestService.js');
      const request = await levelRequestForRating(Number(req.params.ratingId));
      return res.json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to load linked request');
    }
  },
);

router.get(
  '/:id([0-9]+)',
  Auth.verified(),
  ApiDoc({
    operationId: 'getLevelRequest',
    summary: 'Get one level request',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Request'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const request = await getLevelRequestForViewer(user, Number(req.params.id));
      return res.json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to load request');
    }
  },
);

router.post(
  '/level/:levelId([0-9]+)',
  Auth.verified(),
  ApiDoc({
    operationId: 'createLevelRequest',
    summary: 'Submit a level request',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created request'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const request = await createLevelRequest(user, Number(req.params.levelId), req.body || {});
      return res.status(201).json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to create request');
    }
  },
);

router.patch(
  '/:id([0-9]+)',
  Auth.verified(),
  ApiDoc({
    operationId: 'updateOwnLevelRequest',
    summary: 'Edit a pending level request',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated request'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const request = await updateOwnLevelRequest(user, Number(req.params.id), req.body || {});
      return res.json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to update request');
    }
  },
);

router.post(
  '/:id([0-9]+)/withdraw',
  Auth.verified(),
  ApiDoc({
    operationId: 'withdrawLevelRequest',
    summary: 'Withdraw a pending level request',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Withdrawn request'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const request = await withdrawLevelRequest(user, Number(req.params.id));
      return res.json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to withdraw request');
    }
  },
);

router.get(
  '/open-counts',
  Auth.verified(),
  ApiDoc({
    operationId: 'countOpenLevelRequests',
    summary: 'Pending level request counts by type for the current reviewer',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Counts of pending requests'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const counts = await countOpenLevelRequests(user);
      return res.json({counts});
    } catch (error) {
      return sendError(res, error, 'Failed to count requests');
    }
  },
);

router.get(
  '/',
  Auth.verified(),
  ApiDoc({
    operationId: 'listLevelRequests',
    summary: 'List level requests for reviewers',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Paged requests'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const page = await listLevelRequests(user, req.query as Record<string, unknown>);
      return res.json(page);
    } catch (error) {
      return sendError(res, error, 'Failed to list requests');
    }
  },
);

router.patch(
  '/:id([0-9]+)/staff',
  Auth.verified(),
  ApiDoc({
    operationId: 'updateLevelRequestStaff',
    summary: 'Update request notes',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated request'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const request = await updateLevelRequestStaff(user, Number(req.params.id), req.body || {});
      return res.json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to update request');
    }
  },
);

router.post(
  '/:id([0-9]+)/actions',
  Auth.verified(),
  ApiDoc({
    operationId: 'applyLevelRequestAction',
    summary: 'Apply a pipeline action to a level request',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated request'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const request = await applyLevelRequestAction(user, Number(req.params.id), req.body || {});
      return res.json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to apply request action');
    }
  },
);

router.post(
  '/:id([0-9]+)/discord',
  Auth.verified(),
  ApiDoc({
    operationId: 'postLevelRequestDiscord',
    summary: 'Create or retry a Discord vote thread for a rerate request',
    tags: ['Database', 'Level requests'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Posted request'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const user = viewer(req);
      if (!user) return res.status(401).json({error: 'Authentication required'});
      const request = await postLevelRequestDiscord(user, Number(req.params.id));
      return res.json({request});
    } catch (error) {
      return sendError(res, error, 'Failed to post request to Discord');
    }
  },
);

export default router;
