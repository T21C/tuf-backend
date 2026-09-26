import type http from 'node:http';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  BILIBILI_REQUEST_HEADERS,
  DEFAULT_WAVE_TIMEOUT_MS,
  judgeBilibiliHtml,
  proxyAgentUrl,
  type BilibiliProxyFailReason,
  type BilibiliProxyRef,
} from './helpers.js';

const TLS_OFF = { rejectUnauthorized: false } as const;

export function getBilibiliWaveTimeoutMs(): number {
  const raw = Number(process.env.BILIBILI_PROXY_WAVE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_WAVE_TIMEOUT_MS;
}

export function createBilibiliProxyAgent(proxy: BilibiliProxyRef): http.Agent {
  const timeout = getBilibiliWaveTimeoutMs();
  if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
    const agent = new SocksProxyAgent(proxyAgentUrl(proxy), { timeout });
    const connect = agent.connect.bind(agent);
    agent.connect = (async (req, opts) =>
      connect(req, { ...opts, rejectUnauthorized: false } as never)) as typeof agent.connect;
    return agent;
  }
  return new HttpsProxyAgent(proxyAgentUrl(proxy), {
    ...TLS_OFF,
    timeout,
    keepAlive: false,
  });
}

export function bilibiliAxiosConfig(opts: {
  timeoutMs: number;
  proxy?: BilibiliProxyRef | null;
  signal?: AbortSignal;
  responseType?: AxiosRequestConfig['responseType'];
  headers?: Record<string, string>;
  maxContentLength?: number;
}): AxiosRequestConfig {
  const config: AxiosRequestConfig = {
    timeout: opts.timeoutMs,
    signal: opts.signal,
    responseType: opts.responseType,
    headers: opts.headers,
    maxContentLength: opts.maxContentLength,
    maxBodyLength: opts.maxContentLength,
    proxy: false,
    validateStatus: () => true,
  };

  if (opts.proxy) {
    const agent = createBilibiliProxyAgent(opts.proxy);
    config.httpAgent = agent;
    config.httpsAgent = agent;
  }

  return config;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; code?: string };
  return err.name === 'CanceledError' || err.name === 'AbortError' || err.code === 'ERR_CANCELED';
}

export function classifyProxyFetchError(error: unknown): BilibiliProxyFailReason {
  if (axios.isAxiosError(error)) {
    if (
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND'
    ) {
      return 'timeout';
    }
    if (error.response?.status === 412) return 'waf412';
  }
  return 'timeout';
}

function logProxyRequest(
  kind: 'html' | 'cover',
  url: string,
  proxy: BilibiliProxyRef,
  detail: string,
): void {
  if (process.env.BILIBILI_PROXY_LOGGING !== 'true') return;
  logger.debug(`Bilibili proxy ${kind} via ${proxy.id}: GET ${url} ${detail}`);
}

export async function fetchBilibiliHtml(
  bvid: string,
  opts: { proxy?: BilibiliProxyRef | null; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ html: string } | { reason: BilibiliProxyFailReason }> {
  const timeoutMs = opts.timeoutMs ?? getBilibiliWaveTimeoutMs();
  const url = `https://www.bilibili.com/video/${encodeURIComponent(bvid)}/`;
  if (opts.proxy) {
    logProxyRequest('html', url, opts.proxy, `timeout=${timeoutMs}ms`);
  }
  try {
    const response = await axios.get<string>(
      url,
      bilibiliAxiosConfig({
        timeoutMs,
        proxy: opts.proxy,
        signal: opts.signal,
        responseType: 'text',
        headers: {
          ...BILIBILI_REQUEST_HEADERS,
          Accept: 'text/html,application/xhtml+xml',
        },
      }),
    );
    const html = typeof response.data === 'string' ? response.data : '';
    if (response.status === 412) {
      if (opts.proxy) logProxyRequest('html', url, opts.proxy, `-> ${response.status} waf412 bytes=${html.length}`);
      return { reason: 'waf412' };
    }
    if (response.status < 200 || response.status >= 300) {
      if (opts.proxy) logProxyRequest('html', url, opts.proxy, `-> ${response.status} no_meta bytes=${html.length}`);
      return { reason: 'no_meta' };
    }
    const judged = judgeBilibiliHtml(html);
    if (opts.proxy) logProxyRequest('html', url, opts.proxy, `-> ${response.status} ${judged} bytes=${html.length}`);
    if (judged !== 'ok') return { reason: judged };
    return { html };
  } catch (error) {
    if (isAbortError(error)) {
      if (opts.proxy) logProxyRequest('html', url, opts.proxy, 'aborted');
      throw error;
    }
    const reason = classifyProxyFetchError(error);
    if (opts.proxy) logProxyRequest('html', url, opts.proxy, `failed ${reason}`);
    return { reason };
  }
}

export async function fetchBilibiliImage(
  url: string,
  opts: { proxy?: BilibiliProxyRef | null; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ buffer: Buffer; contentType: string } | { reason: BilibiliProxyFailReason }> {
  const timeoutMs = opts.timeoutMs ?? getBilibiliWaveTimeoutMs();
  if (opts.proxy) {
    logProxyRequest('cover', url, opts.proxy, `timeout=${timeoutMs}ms`);
  }
  try {
    const response: AxiosResponse<ArrayBuffer> = await axios.get<ArrayBuffer>(
      url,
      bilibiliAxiosConfig({
        timeoutMs,
        proxy: opts.proxy,
        signal: opts.signal,
        responseType: 'arraybuffer',
        headers: BILIBILI_REQUEST_HEADERS,
        maxContentLength: 10 * 1024 * 1024,
      }),
    );
    const contentType = String(response.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (response.status === 412) {
      if (opts.proxy) logProxyRequest('cover', url, opts.proxy, `-> ${response.status} waf412`);
      return { reason: 'waf412' };
    }
    if (response.status < 200 || response.status >= 300) {
      if (opts.proxy) {
        logProxyRequest('cover', url, opts.proxy, `-> ${response.status} no_meta type=${contentType || 'none'}`);
      }
      return { reason: 'no_meta' };
    }
    if (!contentType.startsWith('image/')) {
      if (opts.proxy) {
        logProxyRequest('cover', url, opts.proxy, `-> ${response.status} no_meta type=${contentType || 'none'}`);
      }
      return { reason: 'no_meta' };
    }
    const buffer = Buffer.from(response.data);
    if (buffer.length === 0) {
      if (opts.proxy) logProxyRequest('cover', url, opts.proxy, `-> ${response.status} no_meta empty`);
      return { reason: 'no_meta' };
    }
    if (opts.proxy) {
      logProxyRequest('cover', url, opts.proxy, `-> ${response.status} ok type=${contentType} bytes=${buffer.length}`);
    }
    return { buffer, contentType };
  } catch (error) {
    if (isAbortError(error)) {
      if (opts.proxy) logProxyRequest('cover', url, opts.proxy, 'aborted');
      throw error;
    }
    const reason = classifyProxyFetchError(error);
    if (opts.proxy) logProxyRequest('cover', url, opts.proxy, `failed ${reason}`);
    return { reason };
  }
}
