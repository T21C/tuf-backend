import AutoSubmissionReceipt from '@/models/submissions/AutoSubmissionReceipt.js';
import {formError} from '@/server/services/submissions/submissionErrors.js';

export async function getRegistrationReceipt(runId: string, ownerId: string, evidenceDigest: string): Promise<number> {
  const receipt = await AutoSubmissionReceipt.findByPk(runId);
  if (!receipt || receipt.ownerId !== ownerId) throw formError.notFound('Registration receipt not found');
  const validation = receipt.validation as {evidence_digest?: unknown};
  if (validation.evidence_digest !== evidenceDigest) throw formError.conflict('Evidence differs from registered run');
  return receipt.passId;
}
