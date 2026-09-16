import { identifySubmissionAccount, requireSubmissionAuthorization } from '@/server/services/autoSubmission/authorization.js';
import { Router } from 'express';
import { z } from 'zod';
import { formError, sendFormError } from '@/server/routes/v2/misc/form/shared/errors.js';
import { getRegistrationReceipt } from '@/server/services/autoSubmission/registrationReceipt.js';
import { registrationSchema } from '@/server/services/autoSubmission/registrationSchema.js';
import { registerAutoSubmission } from '@/server/services/autoSubmission/registerPass.js';
import { requireSubmissionService } from '@/server/services/autoSubmission/serviceAuth.js';

const router: Router = Router();

// Protect the entire router, including any internal endpoints added later.
router.use(requireSubmissionService);

router.post('/identity', async (req, res) => {
  try {
    const parsed = z.object({ access_token: z.string().min(1).max(8192) }).strict().safeParse(req.body);
    if (!parsed.success) throw formError.bad('Invalid identity request');
    res.set('Cache-Control', 'no-store').json(await identifySubmissionAccount(parsed.data.access_token));
  } catch (error) {
    sendFormError(res, error, 'Unable to verify auto submission identity');
  }
});

router.post('/authorization', async (req, res) => {
  try {
    const parsed = z.object({ owner_id: z.uuid(), grant_id: z.uuid() }).strict().safeParse(req.body);
    if (!parsed.success) throw formError.bad('Invalid authorization request');
    res.set('Cache-Control', 'no-store').json(await requireSubmissionAuthorization(parsed.data.owner_id, parsed.data.grant_id));
  } catch (error) {
    sendFormError(res, error, 'Unable to verify auto submission permission');
  }
});

router.post('/register', async (req, res) => {
  try {
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) throw formError.bad('Invalid validated run');
    const passId = await registerAutoSubmission(parsed.data);
    res.json({ pass_id: passId });
  } catch (error) {
    sendFormError(res, error, 'Unable to register auto submission');
  }
});

router.get('/receipts/:runId', async (req, res) => {
  try {
    const parsed = z.object({
      runId: z.uuid(),
      ownerId: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }).safeParse({
      runId: req.params.runId,
      ownerId: req.query.owner_id,
      digest: req.query.evidence_digest,
    });
    if (!parsed.success) throw formError.bad('Invalid receipt request');
    const passId = await getRegistrationReceipt(parsed.data.runId, parsed.data.ownerId, parsed.data.digest);
    res.set('Cache-Control', 'no-store').json({ pass_id: passId });
  } catch (error) {
    sendFormError(res, error, 'Unable to retrieve registration receipt');
  }
});

export default router;
