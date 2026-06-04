import { sanitizeTextInput, validateDateInput, validateFloatInput } from '../shared/sanitize.js';
import { cleanVideoUrl } from '../shared/videoUrl.js';
import { formError } from '../shared/errors.js';
import { sanitizeJudgements } from '@/misc/utils/pass/SanitizeJudgements.js';
import { deriveKeyFlags, normalizeKeyCount } from '@/misc/utils/pass/keyCount.js';

export interface PassFormSanitised {
  levelId: number;
  speed: number;
  videoLink: string;
  passer: string;
  passerId: number | null;
  passerRequest: boolean;
  feelingDifficulty: string;
  expectedDifficulty: string | null;
  keyCount: number | null;
  title: string;
  rawTime: Date;
  is12K: boolean;
  isNoHoldTap: boolean;
  is16K: boolean;
  isAdofaiV2: boolean;
  judgements: ReturnType<typeof sanitizeJudgements>;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

function optionalSanitizedText(body: Record<string, unknown>, field: string): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (typeof raw !== 'string') {
    throw formError.bad(`Invalid field: ${field}`, { field });
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? sanitizeTextInput(trimmed) : null;
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

  const keyCount = normalizeKeyCount(body.keyCount);
  if (body.keyCount !== undefined && body.keyCount !== null && body.keyCount !== '' && keyCount === null) {
    throw formError.bad('Invalid keyCount — must be a positive integer', { field: 'keyCount' });
  }
  const { is12K, is16K } = deriveKeyFlags(keyCount);

  const isNoHoldTap = asBool(body.isNoHoldTap);
  const isAdofaiV2 = asBool(body.isAdofaiV2);
  const passerRequest = asBool(body.passerRequest);
  const expectedDifficulty = optionalSanitizedText(body, 'expectedDifficulty');

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
    expectedDifficulty,
    keyCount,
    title,
    rawTime,
    is12K,
    isNoHoldTap,
    is16K,
    isAdofaiV2,
    judgements,
  };
}
