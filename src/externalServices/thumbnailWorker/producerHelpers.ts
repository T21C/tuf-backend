export class ThumbnailQueueUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ThumbnailQueueUnavailableError';
  }
}

export function shouldReuseExistingThumbnailJob(state: string): boolean {
  return state === 'waiting'
    || state === 'delayed'
    || state === 'active'
    || state === 'paused'
    || state === 'waiting-children'
    || state === 'prioritized';
}

export function isDuplicateJobIdError(error: unknown): boolean {
  return error instanceof Error && /job.*(already exists|exists already)/i.test(error.message);
}

export function thumbnailRenderJobId(outputFileName: string): string {
  return `render_${outputFileName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
