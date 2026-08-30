import {createHash} from 'node:crypto';

export const DOWNLOAD_UNIQUE_WINDOW_DAYS = 7;

export function hashDownloadIp(ip: string): string {
  return createHash('sha256').update(String(ip || '127.0.0.1')).digest('hex');
}

export function utcDayDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function pruneUniquesBeforeDate(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - DOWNLOAD_UNIQUE_WINDOW_DAYS);
  return day.toISOString().slice(0, 10);
}
