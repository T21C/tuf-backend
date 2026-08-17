export const THUMBNAIL_RENDER_JOB_NAME = 'render-html-to-png' as const;

export type ThumbnailEntityType = 'level' | 'rating' | 'player' | 'pass' | 'pack' | 'wheel';

export interface ThumbnailRenderJobData {
  version: 1;
  requestId: string;
  entityType: ThumbnailEntityType;
  entityId: string;
  inputFileName: string;
  outputFileName: string;
  width: number;
  height: number;
  enqueuedAt: string;
}

export interface ThumbnailRenderJobResult {
  outputFileName: string;
  bytes: number;
  renderDurationMs: number;
  completedAt: string;
}
