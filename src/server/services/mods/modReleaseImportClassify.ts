import {hasZipMagic} from './modZipValidate.js';

export type ModReleaseImportSkipReason = 'cdn' | 'github' | 'not-zip';

export type ModReleaseImportDecision =
  | {action: 'ingest'}
  | {action: 'skip'; reason: ModReleaseImportSkipReason};

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isGithubComUrl(url: string): boolean {
  const host = hostnameOf(url);
  return host === 'github.com' || host === 'www.github.com';
}

function looksLikeHtml(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes('text/html');
}

export function classifyModReleaseImport(input: {
  downloadUrl: string;
  isCdn: boolean;
  contentType?: string | null;
  headBytes?: Uint8Array | null;
}): ModReleaseImportDecision {
  if (input.isCdn) return {action: 'skip', reason: 'cdn'};
  if (isGithubComUrl(input.downloadUrl)) return {action: 'skip', reason: 'github'};
  if (looksLikeHtml(input.contentType)) return {action: 'skip', reason: 'not-zip'};
  if (input.headBytes && hasZipMagic(input.headBytes)) return {action: 'ingest'};
  return {action: 'skip', reason: 'not-zip'};
}
