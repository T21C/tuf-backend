import { sanitizeTextInput, validateDateInput, validateFloatInput } from '../shared/sanitize.js';
import { cleanVideoUrl } from '../shared/videoUrl.js';
import { formError } from '../shared/errors.js';
import { sanitizeJudgements } from '@/misc/utils/pass/SanitizeJudgements.js';

export interface PassFormSanitised {
  levelId: number;
  speed: number;
  videoLink: string;
  passer: string;
  passerId: number | null;
  passerRequest: boolean;
  feelingDifficulty: string;
  title: string;
  rawTime: Date;
  is12K: boolean;
  isNoHoldTap: boolean;
  is16K: boolean;
  judgements: ReturnType<typeof sanitizeJudgements>;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

/**
 * Parse + validate a pass submission payload. Throws {@link FormError} on
 * structural problems. Leaves semantic checks (duplicate detection, score
 * validity) for the submission service.
 */
export function parseAndSanitizePassForm(body: Record<string, unknown>): PassFormSanitised {
  const requiredText = (field: string): string => {
    const raw = body[field];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw formError.bad(`Missing or invalid required field: ${field}`, { field });
    }
    return raw.trim();
  };

  const videoLink = cleanVideoUrl(requiredText('videoLink'));
  const passer = sanitizeTextInput(requiredText('passer'));
  const feelingDifficulty = sanitizeTextInput(requiredText('feelingDifficulty'));
  const title = sanitizeTextInput(requiredText('title'));
  requiredText('rawTime');

  const levelIdRaw = body.levelId;
  const levelId = typeof levelIdRaw === 'number' ? levelIdRaw : parseInt(String(levelIdRaw ?? ''));
  if (Number.isNaN(levelId) || levelId <= 0) {
    throw formError.bad('Invalid level ID', { field: 'levelId' });
  }

  const speed = body.speed != null && body.speed !== '' ? validateFloatInput(body.speed, 1, 100) : 1;

  const rawTime = validateDateInput(body.rawTime);
  if (!rawTime) {
    throw formError.bad('Invalid or missing rawTime — must be a valid date between 2020 and now', {
      field: 'rawTime',
    });
  }

  const is12K = asBool(body.is12K);
  const isNoHoldTap = asBool(body.isNoHoldTap);
  const is16K = asBool(body.is16K);
  const passerRequest = asBool(body.passerRequest);

  let passerId: number | null = null;
  if (body.passerId !== undefined && body.passerId !== null && body.passerId !== '') {
    const parsed = typeof body.passerId === 'number' ? body.passerId : parseInt(String(body.passerId));
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw formError.bad('Invalid passerId — must be a positive integer', { field: 'passerId' });
    }
    passerId = parsed;
  }

  const judgements = sanitizeJudgements(body);

  return {
    levelId,
    speed,
    videoLink,
    passer,
    passerId,
    passerRequest,
    feelingDifficulty,
    title,
    rawTime,
    is12K,
    isNoHoldTap,
    is16K,
    judgements,
  };
}
