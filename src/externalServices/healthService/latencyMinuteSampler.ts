import { Op } from 'sequelize';
import HealthLatencySample from '@/models/health/HealthLatencySample.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { HEALTH_CONFIG } from './config.js';
import { httpProbe } from './probes/httpProbe.js';
import { runProbe as dbProbe } from './probes/dbProbe.js';
import type { HealthLatencyComponent } from '@/models/health/HealthLatencySample.js';

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return true;
  }
}

function mainServerProbeUrl(): string {
  return HEALTH_CONFIG.mainServerUrl.replace(/\/$/, '');
}

function cdnProbeUrl(): string {
  return HEALTH_CONFIG.cdnUrl.replace(/\/$/, '');
}

async function purgeOlderThan14Days(): Promise<void> {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  for (;;) {
    const deleted = await HealthLatencySample.destroy({
      where: {
        recordedAt: {
          [Op.lt]: cutoff,
        },
      },
      limit: 5000,
    });
    if (!deleted || deleted < 5000) break;
  }
}

/**
 * Record latency samples on a fixed interval (see `HEALTH_CONFIG.latencySamplerIntervalMs`).
 * Short-window history charts merge rows into one point per minute using a median so
 * isolated slow probes do not skew the curve.
 */
export async function runLatencyMinuteSamplerTick(): Promise<void> {
  const recordedAt = new Date();
  const timeoutMs = HEALTH_CONFIG.probeTimeoutMs;

  const payloads: Array<{
    component: HealthLatencyComponent;
    recordedAt: Date;
    durationMs: number | null;
    ok: boolean;
  }> = [];

  try {
    const dbResult = await dbProbe(timeoutMs);
    payloads.push({
      component: 'database',
      recordedAt,
      durationMs: Number.isFinite(dbResult.durationMs) ? dbResult.durationMs : null,
      ok: dbResult.ok === true,
    });
  } catch (error) {
    logger.warn('[health] latency sampler database probe threw', {
      error: error instanceof Error ? error.message : String(error),
    });
    payloads.push({
      component: 'database',
      recordedAt,
      durationMs: null,
      ok: false,
    });
  }

  const mainUrl = mainServerProbeUrl();
  if (!isLoopbackUrl(mainUrl)) {
    try {
      const mainResult = await httpProbe(mainUrl, timeoutMs);
      payloads.push({
        component: 'main_server',
        recordedAt,
        durationMs: Number.isFinite(mainResult.durationMs) ? mainResult.durationMs : null,
        ok: mainResult.ok === true,
      });
    } catch (error) {
      logger.warn('[health] latency sampler main HTTP probe threw', {
        error: error instanceof Error ? error.message : String(error),
      });
      payloads.push({
        component: 'main_server',
        recordedAt,
        durationMs: null,
        ok: false,
      });
    }
  }

  const cdnUrlFull = cdnProbeUrl();
  if (!isLoopbackUrl(cdnUrlFull)) {
    try {
      const cdnResult = await httpProbe(cdnUrlFull, timeoutMs);
      payloads.push({
        component: 'cdn',
        recordedAt,
        durationMs: Number.isFinite(cdnResult.durationMs) ? cdnResult.durationMs : null,
        ok: cdnResult.ok === true,
      });
    } catch (error) {
      logger.warn('[health] latency sampler CDN HTTP probe threw', {
        error: error instanceof Error ? error.message : String(error),
      });
      payloads.push({
        component: 'cdn',
        recordedAt,
        durationMs: null,
        ok: false,
      });
    }
  }

  await HealthLatencySample.bulkCreate(payloads);

  try {
    await purgeOlderThan14Days();
  } catch (error) {
    logger.warn('[health] latency retention purge failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
