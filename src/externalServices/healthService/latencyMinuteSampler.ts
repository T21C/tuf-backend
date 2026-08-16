import { Op } from 'sequelize';
import HealthLatencySample from '@/models/health/HealthLatencySample.js';
import { logger } from '@/server/services/core/LoggerService.js';
import type { HealthLatencyComponent } from '@/models/health/HealthLatencySample.js';
import type { ProbeName, ProbeResult } from './probes/types.js';

const SAMPLE_COMPONENTS: ReadonlyArray<{
  probe: ProbeName;
  component: HealthLatencyComponent;
}> = [
  { probe: 'database', component: 'database' },
  { probe: 'mainServer', component: 'main_server' },
  { probe: 'cdn', component: 'cdn' },
];

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
 * Persist the latest live-probe latencies (see `HEALTH_CONFIG.latencySamplerIntervalMs`).
 * Status probes already hit loopback API/CDN and log slow/down/recovered; this tick
 * only writes those measurements so history charts match `/health/api`.
 * Short-window charts merge rows into one point per minute using a median so
 * isolated slow probes do not skew the curve.
 */
export async function runLatencyMinuteSamplerTick(
  results: ReadonlyMap<ProbeName, ProbeResult>,
): Promise<void> {
  const recordedAt = new Date();
  const payloads: Array<{
    component: HealthLatencyComponent;
    recordedAt: Date;
    durationMs: number | null;
    ok: boolean;
  }> = [];

  for (const { probe, component } of SAMPLE_COMPONENTS) {
    const result = results.get(probe);
    if (!result || result.skipped) continue;
    payloads.push({
      component,
      recordedAt,
      durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
      ok: result.ok === true,
    });
  }

  if (payloads.length > 0) {
    await HealthLatencySample.bulkCreate(payloads);
  }

  try {
    await purgeOlderThan14Days();
  } catch (error) {
    logger.warn('[health] latency retention purge failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
