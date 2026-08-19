export type SubmissionKind = 'level' | 'pass';
export type SubmissionAction = 'approve' | 'decline';

export type SubmissionRequestStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type SubmissionItemStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped';

export type SubmissionStepStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type SubmissionRequestedBy = {
  userId: string;
  username: string;
};

export type SubmissionStepState = {
  id: string;
  status: SubmissionStepStatus;
};

export type SubmissionItemState = {
  kind: SubmissionKind;
  action: SubmissionAction;
  itemId: number;
  label: string;
  status: SubmissionItemStatus;
  steps: SubmissionStepState[];
  requestIds: string[];
  levelId?: number | null;
  passId?: number | null;
  error?: string;
  updatedAt: number;
};

export type SubmissionRequestOrigin = 'manual' | 'auto';

export type SubmissionRequestState = {
  requestId: string;
  kind: SubmissionKind;
  action: SubmissionAction;
  origin: SubmissionRequestOrigin;
  requestedBy: SubmissionRequestedBy;
  itemIds: number[];
  status: SubmissionRequestStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

export type SubmissionRequestTree = SubmissionRequestState & {
  items: SubmissionItemState[];
};

export type SubmissionQueuePayload = {
  kind: SubmissionKind;
  action: SubmissionAction;
  itemId: number;
  requestId: string;
  actorId: string | null;
};

export const LEVEL_APPROVE_STEPS = [
  'validate',
  'resolveEntities',
  'createLevel',
  'notify',
  'chartStats',
  'autoTags',
] as const;

export const LEVEL_DECLINE_STEPS = ['validate', 'cleanup', 'notify'] as const;

export const PASS_APPROVE_STEPS = ['validate', 'createPass', 'index', 'roleSync'] as const;

export const PASS_DECLINE_STEPS = ['validate', 'notify'] as const;

export function submissionItemKey(kind: SubmissionKind, itemId: number): string {
  return `${kind}:${itemId}`;
}

export function isTerminalItemStatus(status: SubmissionItemStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped';
}

export function shouldSkipEnqueue(status: SubmissionItemStatus | undefined): 'inflight' | 'done' | null {
  if (!status) return null;
  if (status === 'queued' || status === 'processing') return 'inflight';
  if (status === 'completed' || status === 'skipped') return 'done';
  return null;
}

export function buildSteps(kind: SubmissionKind, action: SubmissionAction): SubmissionStepState[] {
  const ids =
    kind === 'level'
      ? action === 'approve'
        ? LEVEL_APPROVE_STEPS
        : LEVEL_DECLINE_STEPS
      : action === 'approve'
        ? PASS_APPROVE_STEPS
        : PASS_DECLINE_STEPS;
  return ids.map(id => ({ id, status: 'pending' as const }));
}

export function encodeQueuePayload(payload: SubmissionQueuePayload): string {
  return JSON.stringify(payload);
}

export function parseQueuePayload(raw: string): SubmissionQueuePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SubmissionQueuePayload>;
    if (
      (parsed.kind !== 'level' && parsed.kind !== 'pass')
      || (parsed.action !== 'approve' && parsed.action !== 'decline')
      || !Number.isFinite(parsed.itemId)
      || typeof parsed.requestId !== 'string'
      || parsed.requestId.length === 0
    ) {
      return null;
    }
    return {
      kind: parsed.kind,
      action: parsed.action,
      itemId: Number(parsed.itemId),
      requestId: parsed.requestId,
      actorId: typeof parsed.actorId === 'string' ? parsed.actorId : null,
    };
  } catch {
    return null;
  }
}

export function advanceSteps(
  steps: SubmissionStepState[],
  stepId: string,
): SubmissionStepState[] {
  return steps.map(step => {
    if (step.id === stepId) return { ...step, status: 'processing' };
    if (step.status === 'processing') return { ...step, status: 'completed' };
    return step;
  });
}

export function completeAllSteps(steps: SubmissionStepState[]): SubmissionStepState[] {
  return steps.map(step =>
    step.status === 'failed' ? step : { ...step, status: 'completed' },
  );
}

export function failCurrentStep(steps: SubmissionStepState[]): SubmissionStepState[] {
  return steps.map(step =>
    step.status === 'processing' ? { ...step, status: 'failed' } : step,
  );
}

export function shouldRecoverActivePayload(options: {
  lockHeld: boolean;
  itemStatus: SubmissionItemStatus | undefined;
}): 'wait' | 'requeue' | 'clear' {
  if (options.lockHeld) return 'wait';
  if (
    !options.itemStatus
    || options.itemStatus === 'queued'
    || options.itemStatus === 'processing'
  ) {
    return 'requeue';
  }
  return 'clear';
}
