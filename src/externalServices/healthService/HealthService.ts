import express from 'express';
import http from 'http';
import { logger } from '@/server/services/core/LoggerService.js';
import { HEALTH_CONFIG } from './config.js';
import {
  dbProbe,
  makeCdcProbe,
  makeCdnProbe,
  makeMainServerProbe,
  makeNginxProbe,
  type ProbeFn,
  type ProbeName,
  type ProbeResult,
} from './probes/index.js';

type OverallStatus = 'online' | 'degraded' | 'offline';

/**
 * Probes whose failure can drive `offline`. Other probes (cdn, cdc, nginx) are
 * informational and may at most downgrade the overall status from `online` to
 * `degraded`, so adding them never breaks pre-existing alerting on the legacy
 * `checks` map.
 */
const REQUIRED_PROBES: ReadonlyArray<ProbeName> = ['database', 'mainServer'];

interface ProbeRegistration {
  name: ProbeName;
  run: ProbeFn;
}

export class HealthService {
  private static instance: HealthService;
  private app: express.Application;
  private server: http.Server | null = null;
  private readonly port = HEALTH_CONFIG.port;
  private isRunning = false;
  private startTime: Date | null = null;
  private lastCheckTime: Date | null = null;
  private status: OverallStatus = 'online';
  private checkInterval: NodeJS.Timeout | null = null;

  private readonly probes: ReadonlyArray<ProbeRegistration>;
  private readonly results = new Map<ProbeName, ProbeResult>();
  private readonly previousOk = new Map<ProbeName, boolean>();

  private constructor() {
    this.app = express();
    this.probes = [
      { name: 'database', run: dbProbe },
      { name: 'mainServer', run: makeMainServerProbe(HEALTH_CONFIG.mainServerUrl) },
      { name: 'cdn', run: makeCdnProbe(HEALTH_CONFIG.cdnUrl) },
      { name: 'cdc', run: makeCdcProbe(HEALTH_CONFIG.cdcUrl) },
      { name: 'nginx', run: makeNginxProbe(HEALTH_CONFIG.nginxUrl || undefined) },
    ];
    this.setupRoutes();
  }

  public static getInstance(): HealthService {
    if (!HealthService.instance) {
      HealthService.instance = new HealthService();
    }
    return HealthService.instance;
  }

  // ------------------------------------------------------------------
  // Probe execution + status derivation
  // ------------------------------------------------------------------

  /**
   * Run every probe in parallel with a per-probe timeout budget.
   * Failures are caught here so the overall status calculation always sees a
   * complete map. Transition / slow-probe logging happens in
   * {@link recordResult}.
   */
  private async runHealthChecks(): Promise<void> {
    this.lastCheckTime = new Date();

    const settled = await Promise.allSettled(
      this.probes.map(async (probe) => {
        const start = Date.now();
        try {
          const result = await probe.run(HEALTH_CONFIG.probeTimeoutMs);
          return { probe, result };
        } catch (error) {
          return {
            probe,
            result: {
              ok: false,
              durationMs: Date.now() - start,
              message: error instanceof Error ? error.message : String(error),
              details: { unhandled: true },
            } as ProbeResult,
          };
        }
      }),
    );

    for (const entry of settled) {
      if (entry.status !== 'fulfilled') continue;
      this.recordResult(entry.value.probe.name, entry.value.result);
    }

    this.status = this.computeStatus();
  }

  private recordResult(name: ProbeName, result: ProbeResult): void {
    this.results.set(name, result);

    if (result.skipped) {
      logger.debug(`[health] ${name} skipped`, { component: name, message: result.message });
      return;
    }

    const prevOk = this.previousOk.get(name);
    const isTransition = prevOk !== undefined && prevOk !== result.ok;
    this.previousOk.set(name, result.ok);

    const meta = {
      component: name,
      ok: result.ok,
      durationMs: result.durationMs,
      message: result.message,
      details: result.details,
    };

    if (isTransition) {
      if (result.ok) {
        logger.info(`[health] ${name} recovered`, meta);
      } else {
        logger.warn(`[health] ${name} went down`, meta);
      }
    } else if (!result.ok) {
      // Persistent failure: keep at debug to avoid log spam, but emit periodically via slow-probe path below.
      logger.debug(`[health] ${name} still failing`, meta);
    } else if (result.durationMs > HEALTH_CONFIG.slowProbeThresholdMs) {
      logger.warn(`[health] ${name} slow probe (${result.durationMs}ms)`, meta);
    } else {
      logger.debug(`[health] ${name} ok (${result.durationMs}ms)`, meta);
    }
  }

  /**
   * Status rules:
   * - `online`  : every required probe ok AND every active optional probe ok.
   * - `degraded`: at least one probe failing but at most one **required** probe failing.
   * - `offline` : two or more required probes failing.
   *
   * Skipped probes are excluded entirely so disabling nginx (the dev case) can
   * never affect status.
   */
  private computeStatus(): OverallStatus {
    let requiredFailures = 0;
    let optionalFailures = 0;

    for (const probe of this.probes) {
      const result = this.results.get(probe.name);
      if (!result || result.skipped) continue;
      if (result.ok) continue;
      if (REQUIRED_PROBES.includes(probe.name)) {
        requiredFailures += 1;
      } else {
        optionalFailures += 1;
      }
    }

    if (requiredFailures >= 2) return 'offline';
    if (requiredFailures === 1 || optionalFailures > 0) return 'degraded';
    return 'online';
  }

  /**
   * Legacy `checks` map shape: only the two keys the original implementation
   * exposed (`database`, `mainServer`). New probes (cdn, cdc, nginx) are
   * surfaced solely under `details.probes` so the legacy contract is byte-for-byte preserved.
   */
  private buildLegacyChecksMap(): { database: boolean; mainServer: boolean } {
    const dbResult = this.results.get('database');
    const mainResult = this.results.get('mainServer');
    return {
      database: dbResult?.ok === true,
      mainServer: mainResult?.ok === true,
    };
  }

  // ------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------

  private setupRoutes(): void {
    this.app.get('/health', (_req, res) => {
      res.send(this.renderHtml());
    });

    this.app.get('/health/api', async (req, res) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        return res.status(200).end();
      }

      await this.runHealthChecks();
      return res.json(this.buildLegacyJson());
    });
  }

  /**
   * Build the legacy `/health/api` response shape consumed by
   * `client/src/pages/misc/HealthCheckPage`. The original keys
   * (`status`, `timestamp`, `uptime`, `checks.database`, `checks.mainServer`,
   * `mainServerInfo`) are preserved; new probe data is exposed under the
   * additive `details` field so existing consumers ignore it.
   */
  private buildLegacyJson(): Record<string, unknown> {
    const checks = this.buildLegacyChecksMap();
    const mainServerInfo = (this.results.get('mainServer')?.details?.mainServerInfo ?? null) as unknown;

    const probeDetails: Record<string, ProbeResult> = {};
    for (const [name, result] of this.results.entries()) {
      probeDetails[name] = result;
    }

    return {
      status: this.status,
      timestamp: (this.lastCheckTime ?? new Date()).toISOString(),
      uptime: this.getUptime(),
      checks,
      mainServerInfo,
      details: {
        probes: probeDetails,
        config: {
          mainServerUrl: HEALTH_CONFIG.mainServerUrl,
          cdnUrl: HEALTH_CONFIG.cdnUrl,
          cdcUrl: HEALTH_CONFIG.cdcUrl,
          nginxUrl: HEALTH_CONFIG.nginxUrl || null,
          probeIntervalMs: HEALTH_CONFIG.probeIntervalMs,
          probeTimeoutMs: HEALTH_CONFIG.probeTimeoutMs,
        },
      },
    };
  }

  // ------------------------------------------------------------------
  // HTML rendering (output preserved against the legacy implementation)
  // ------------------------------------------------------------------

  private renderHtml(): string {
    const uptime = this.startTime ? this.getUptime() : 'Not started';
    const lastCheck = this.lastCheckTime ? this.lastCheckTime.toISOString() : 'Never';

    const formatUptime = (seconds: number) => {
      const days = Math.floor(seconds / (24 * 60 * 60));
      const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
      const minutes = Math.floor((seconds % (60 * 60)) / 60);
      const secs = Math.floor(seconds % 60);
      return `${days}d ${hours}h ${minutes}m ${secs}s`;
    };

    const mainServerInfo = (this.results.get('mainServer')?.details?.mainServerInfo ?? null) as
      | {
          status?: string;
          system?: {
            uptime?: number;
            env?: string;
            nodeVersion?: string;
            platform?: string;
          };
        }
      | null;

    const checks = this.buildLegacyChecksMap();
    const dbOk = checks.database;
    const mainOk = checks.mainServer;

    const mainServerUptime = mainServerInfo?.system?.uptime
      ? formatUptime(mainServerInfo.system.uptime)
      : 'Unknown';
    const mainServerStatus = mainServerInfo?.status || 'Unknown';
    const mainServerEnv = mainServerInfo?.system?.env || 'Unknown';
    const mainServerNodeVersion = mainServerInfo?.system?.nodeVersion || 'Unknown';
    const mainServerPlatform = mainServerInfo?.system?.platform || 'Unknown';

    return `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Health Status</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              line-height: 1.6;
            }
            h1 {
              color: ${this.getStatusColor()};
            }
            .status {
              font-weight: bold;
              color: ${this.getStatusColor()};
            }
            .check {
              margin: 10px 0;
              padding: 10px;
              border-radius: 4px;
              background-color: #f5f5f5;
            }
            .check.online {
              border-left: 4px solid #4CAF50;
            }
            .check.offline {
              border-left: 4px solid #F44336;
            }
            .check.degraded {
              border-left: 4px solid #FF9800;
            }
            .info {
              margin-top: 20px;
              padding: 15px;
              background-color: #e9f7fe;
              border-radius: 4px;
            }
            .resource-info {
              margin-top: 20px;
              padding: 15px;
              background-color: #f0f8f0;
              border-radius: 4px;
            }
            .resource-info h3 {
              margin-top: 0;
              color: #2E7D32;
            }
            .resource-grid {
              display: grid;
              grid-template-columns: repeat(2, 1fr);
              gap: 10px;
            }
            .resource-item {
              padding: 8px;
              background-color: #fff;
              border-radius: 4px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            .resource-label {
              font-weight: bold;
              color: #555;
            }
            .resource-value {
              color: #333;
            }
            .timestamp {
              font-size: 0.8em;
              color: #666;
              margin-top: 10px;
            }
          </style>
        </head>
        <body>
          <h1>Health Status: <span class="status">${this.status.toUpperCase()}</span></h1>

          <div class="info">
            <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
            <p><strong>Health Service Port:</strong> ${this.port}</p>
            <p><strong>Main Server URL:</strong> ${HEALTH_CONFIG.mainServerUrl}</p>
            <p><strong>Uptime:</strong> ${uptime}</p>
            <p><strong>Last Check:</strong> ${lastCheck}</p>
          </div>

          <h2>Component Status</h2>

          <div class="check ${dbOk ? 'online' : 'offline'}">
            <p><strong>Database:</strong> ${dbOk ? 'Connected' : 'Disconnected'}</p>
          </div>

          <div class="check ${mainOk ? 'online' : 'offline'}">
            <p><strong>Main Server:</strong> ${mainOk ? 'Running' : 'Not Running'}</p>
            <p><strong>Status:</strong> <span style="color: ${this.getStatusColorForServer(mainServerStatus)}">${mainServerStatus.toUpperCase()}</span></p>
          </div>

          ${this.renderExtraProbesHtml()}

          ${mainServerInfo ? `
          <div class="resource-info">
            <h3>Main Server Resources</h3>
            <div class="resource-grid">
              <div class="resource-item">
                <div class="resource-label">Uptime</div>
                <div class="resource-value">${mainServerUptime}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Environment</div>
                <div class="resource-value">${mainServerEnv}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Node Version</div>
                <div class="resource-value">${mainServerNodeVersion}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Platform</div>
                <div class="resource-value">${mainServerPlatform}</div>
              </div>
            </div>

            <div class="timestamp">
              Last updated: ${this.lastCheckTime ? new Date(this.lastCheckTime).toLocaleString() : 'Never'}
            </div>
          </div>
          ` : ''}

          <script>
            setTimeout(() => {
              window.location.reload();
            }, 5000);
          </script>
        </body>
        </html>
      `;
  }

  /** Render the new (cdn / cdc / nginx) probes inline with the legacy ones using the same `.check` styles. */
  private renderExtraProbesHtml(): string {
    const extras: ProbeName[] = ['cdn', 'cdc', 'nginx'];
    const labels: Record<ProbeName, string> = {
      database: 'Database',
      mainServer: 'Main Server',
      cdn: 'CDN Service',
      cdc: 'CDC Service',
      nginx: 'Nginx',
    };

    const blocks: string[] = [];
    for (const name of extras) {
      const result = this.results.get(name);
      if (!result || result.skipped) continue;
      const cls = result.ok ? 'online' : 'offline';
      const stateText = result.ok ? 'Running' : 'Not Running';
      const detail = result.message ? ` <em style="color:#777">(${result.durationMs}ms · ${result.message})</em>` : '';
      blocks.push(`
          <div class="check ${cls}">
            <p><strong>${labels[name]}:</strong> ${stateText}${detail}</p>
          </div>`);
    }
    return blocks.join('');
  }

  // ------------------------------------------------------------------
  // Lifecycle helpers
  // ------------------------------------------------------------------

  private getStatusColor(): string {
    return this.getStatusColorForServer(this.status);
  }

  private getStatusColorForServer(status: string): string {
    switch (status) {
      case 'online':
        return '#4CAF50';
      case 'degraded':
        return '#FF9800';
      case 'offline':
        return '#F44336';
      default:
        return '#000000';
    }
  }

  private getUptime(): string {
    if (!this.startTime) return 'Not started';
    const uptimeMs = Date.now() - this.startTime.getTime();
    const seconds = Math.floor((uptimeMs / 1000) % 60);
    const minutes = Math.floor((uptimeMs / (1000 * 60)) % 60);
    const hours = Math.floor((uptimeMs / (1000 * 60 * 60)) % 24);
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[health] service already running');
      return;
    }

    try {
      this.server = http.createServer(this.app);
      this.server.listen(this.port, '::', () => {
        this.isRunning = true;
        this.startTime = new Date();
        const enabled = this.probes
          .map((p) => (p.name === 'nginx' && !HEALTH_CONFIG.nginxUrl ? `${p.name}(skipped)` : p.name))
          .join(', ');
        logger.info(`[health] listening on :${this.port} (probes: ${enabled})`, {
          port: this.port,
          mainServerUrl: HEALTH_CONFIG.mainServerUrl,
          cdnUrl: HEALTH_CONFIG.cdnUrl,
          cdcUrl: HEALTH_CONFIG.cdcUrl,
          nginxUrl: HEALTH_CONFIG.nginxUrl || null,
          intervalMs: HEALTH_CONFIG.probeIntervalMs,
          timeoutMs: HEALTH_CONFIG.probeTimeoutMs,
        });
      });

      await this.runHealthChecks();

      this.checkInterval = setInterval(() => {
        void this.runHealthChecks();
      }, HEALTH_CONFIG.probeIntervalMs);
      this.checkInterval.unref?.();
    } catch (error) {
      logger.error('[health] failed to start service', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      logger.warn('[health] service not running');
      return;
    }

    try {
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }

      await new Promise<void>((resolve) => {
        this.server?.close(() => {
          this.isRunning = false;
          this.server = null;
          logger.info('[health] service stopped');
          resolve();
        });
      });
    } catch (error) {
      logger.error('[health] error stopping service', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public getStatus(): OverallStatus {
    return this.status;
  }

  public isServiceRunning(): boolean {
    return this.isRunning;
  }
}
