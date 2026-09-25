import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import Pass from '@/models/passes/Pass.js';
import { Auth } from '@/server/middleware/auth.js';
import { formError, sendFormError } from '@/server/routes/v2/misc/form/shared/errors.js';
import { ownsReplayPass, requestPassVisuals, visualDefaultsSchema } from '@/server/services/autoSubmission/passVisuals.js';

const router: Router = Router();
async function handle(req: Request, res: Response, operation: 'read' | 'defaults' | 'visibility') {
  try {
    const passId = z.coerce.number().int().positive().parse(req.params.id);
    const pass = await Pass.findByPk(passId);
    if (!pass || pass.isDeleted || !pass.autoSubmissionRunId) throw formError.notFound('Replay pass not found');
    if (!ownsReplayPass(req.user, pass)) throw formError.forbid('Only the submitter can change replay visuals');
    const defaults = operation === 'defaults' ? visualDefaultsSchema.parse(req.body) : undefined;
    const visibility = operation === 'visibility' ? z.object({ hidden: z.boolean() }).strict().parse(req.body) : undefined;
    const result = await requestPassVisuals({
      operation, runId: pass.autoSubmissionRunId, passId, ownerId: req.user!.id,
      ...(defaults ? { defaults } : {}),
      ...(visibility ? { presetId: z.uuid().parse(req.params.presetId), hidden: visibility.hidden } : {}),
    });
    res.set('Cache-Control', 'no-store').json(result);
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid replay visual settings' }); return; }
    sendFormError(res, error, 'Unable to update replay visual settings');
  }
}

// Full TUF web-session authentication, not the mod OAuth or internal-service credential.
router.get('/:id([0-9]{1,20})/replay-visuals', Auth.user(), (req,res) => handle(req,res,'read'));
router.put('/:id([0-9]{1,20})/replay-visuals', Auth.user(), (req,res) => handle(req,res,'defaults'));
router.put('/:id([0-9]{1,20})/replay-visuals/:presetId/visibility', Auth.user(), (req,res) => handle(req,res,'visibility'));
export default router;
