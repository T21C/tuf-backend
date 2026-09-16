import {pathToFileURL} from 'node:url';
import {z} from 'zod';

export const AUTO_SUBMISSION_OPERATOR_DEFAULTS = Object.freeze({
  testerUsername: 'impl.dev',
  testerPlayerId: 7410,
  testerUserId: '670cac2c-8175-46a6-87f7-b92741d4499f',
  oauthClientId: '1dc9ff206f5301c9e7ef4ba9b209c7c7',
  oauthRedirectUri: 'https://tufreplay-auto.impl1113.dev/oauth/callback',
  oauthAllowedScopeBits: '65537',
  replayApiBaseUrl: 'https://tufreplay-auto.impl1113.dev',
  publicPlayerApiBaseUrl: 'https://api.tuforums.com',
});

const uuidSchema = z.uuid();

export type PlayerLookupResult = {
  user_id: string;
  username: string;
  player_id: number;
  player_name: string | null;
  source_url: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parsePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Public player lookup returned an invalid ${field}`);
  }
  return parsed;
}

export function makePlayerLookupUrl(baseUrl: string, playerId: number): URL {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error('player-id must be a positive integer');
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('API base URL must be an absolute URL');
  }
  const localHttp = base.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname.toLowerCase());
  if (base.protocol !== 'https:' && !localHttp) {
    throw new Error('API base URL must use HTTPS (HTTP is allowed only for loopback testing)');
  }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('API base URL must be an origin only, with no credentials, path, query, or fragment');
  }
  return new URL(`/v2/database/players/${playerId}`, base);
}

function extractPlayerRecord(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  const envelope = asRecord(root?.data) ?? root;
  const player = asRecord(envelope?.player) ?? envelope;
  if (!player) throw new Error('Public player lookup returned an unexpected response');
  return player;
}

export async function lookupTrustedTester(params: {
  baseUrl?: string;
  playerId: number;
  username: string;
  fetchImpl?: typeof fetch;
}): Promise<PlayerLookupResult> {
  const expectedUsername = params.username.trim();
  if (!expectedUsername) throw new Error('username is required');
  const url = makePlayerLookupUrl(
    params.baseUrl ?? AUTO_SUBMISSION_OPERATOR_DEFAULTS.publicPlayerApiBaseUrl,
    params.playerId,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {accept: 'application/json'},
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Public player lookup failed with HTTP ${response.status}`);

  const player = extractPlayerRecord(await response.json());
  const account = asRecord(player.user) ?? asRecord(player.account);
  if (!account) throw new Error('Public player lookup did not include a connected TUF account');

  const observedPlayerId = parsePositiveInteger(player.id ?? player.playerId ?? player.player_id, 'player id');
  const accountPlayerId = parsePositiveInteger(
    account.playerId ?? account.player_id,
    'connected account player id',
  );
  if (observedPlayerId !== params.playerId || accountPlayerId !== params.playerId) {
    throw new Error('Public player lookup returned a different player id');
  }
  const username = typeof account.username === 'string' ? account.username : '';
  if (!username || username.toLocaleLowerCase('en-US') !== expectedUsername.toLocaleLowerCase('en-US')) {
    throw new Error('Public player lookup username did not match the requested TUF account');
  }
  const userId = typeof account.id === 'string' ? account.id : '';
  const parsedUserId = uuidSchema.safeParse(userId);
  if (!parsedUserId.success) throw new Error('Public player lookup returned an invalid connected user UUID');

  return {
    user_id: parsedUserId.data,
    username,
    player_id: observedPlayerId,
    player_name: typeof player.name === 'string' ? player.name : null,
    source_url: url.href,
  };
}

export function makeAutoSubmissionSetupPlan(options: {
  trustedUserId?: string;
  enabled?: boolean;
  clientId?: string;
  redirectUri?: string;
  allowedScopeBits?: string;
  replayApiBaseUrl?: string;
} = {}) {
  const trustedUserId = options.trustedUserId ?? AUTO_SUBMISSION_OPERATOR_DEFAULTS.testerUserId;
  if (!uuidSchema.safeParse(trustedUserId).success) throw new Error('trusted-user-id must be a UUID');
  const clientId = options.clientId ?? AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthClientId;
  if (clientId !== AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthClientId) {
    throw new Error('client-id differs from the official auto-submission OAuth app');
  }
  const redirectUri = options.redirectUri ?? AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthRedirectUri;
  if (redirectUri !== AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthRedirectUri) {
    throw new Error('redirect-uri differs from the registered OAuth callback');
  }
  const allowedScopeBits = options.allowedScopeBits ?? AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthAllowedScopeBits;
  if (allowedScopeBits !== AUTO_SUBMISSION_OPERATOR_DEFAULTS.oauthAllowedScopeBits) {
    throw new Error('allowed-scope-bits must include the official auto-submission scope configuration');
  }
  const replayApiBaseUrl = options.replayApiBaseUrl ?? AUTO_SUBMISSION_OPERATOR_DEFAULTS.replayApiBaseUrl;
  let apiUrl: URL;
  try {
    apiUrl = new URL(replayApiBaseUrl);
  } catch {
    throw new Error('replay-api-base-url must be an absolute URL');
  }
  if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error('replay API URL must be an HTTPS origin or base path without credentials/query/fragment');
  }

  return {
    mode: 'proposal_only',
    backend_environment: {
      AUTO_SUBMISSION_ENABLED: options.enabled === true ? 'true' : 'false',
      AUTO_SUBMISSION_TRUSTED_USER_IDS: trustedUserId.toLowerCase(),
      TUF_AUTO_SUBMISSION_OAUTH_CLIENT_ID: clientId,
    },
    replay_runtime_environment: {
      AUTO_SUBMISSION_API_URL: apiUrl.href.replace(/\/$/, ''),
    },
    oauth_app_checklist: {
      client_id: clientId,
      client_type: 'public',
      redirect_uri: redirectUri,
      required_scope_name: 'User.Submission.Create',
      allowed_scope_bits: allowedScopeBits,
      authorization_code_pkce: 'S256 required by TUF OAuth server',
    },
    note: 'Printed only; no file is written and no OAuth, TUF, or deployment setting is changed.',
  };
}

export function checkOAuthAppSettings(options: {
  clientId: string;
  redirectUri: string;
  allowedScopeBits: string;
}) {
  const plan = makeAutoSubmissionSetupPlan(options);
  return {
    matches_official_app: true,
    client_id: plan.oauth_app_checklist.client_id,
    redirect_uri: plan.oauth_app_checklist.redirect_uri,
    allowed_scope_bits: plan.oauth_app_checklist.allowed_scope_bits,
    authorization_code_pkce: plan.oauth_app_checklist.authorization_code_pkce,
    public_client: plan.oauth_app_checklist.client_type === 'public',
  };
}

function parseArguments(args: string[]): {command: string; values: Record<string, string | boolean>} {
  const [command, ...rest] = args;
  if (!command) throw new Error('Expected one of: lookup, plan, check-oauth');
  const values: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'enable') {
      values[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    values[key] = value;
    index += 1;
  }
  return {command, values};
}

function requiredString(values: Record<string, string | boolean>, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

function optionalString(values: Record<string, string | boolean>, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} must have a value`);
  return value.trim();
}

export async function runOperatorCommand(args: string[]): Promise<unknown> {
  const {command, values} = parseArguments(args);
  switch (command) {
    case 'lookup': {
      const playerId = parsePositiveInteger(requiredString(values, 'player-id'), 'player id');
      const username = requiredString(values, 'username');
      const baseUrl = optionalString(values, 'base-url');
      if (values['dry-run'] === true) {
        const url = makePlayerLookupUrl(
          baseUrl ?? AUTO_SUBMISSION_OPERATOR_DEFAULTS.publicPlayerApiBaseUrl,
          playerId,
        );
        return {
          mode: 'dry_run',
          method: 'GET',
          url: url.href,
          authorization_header: false,
          result: 'No request was made.',
        };
      }
      return lookupTrustedTester({baseUrl, playerId, username});
    }
    case 'plan':
      return makeAutoSubmissionSetupPlan({
        trustedUserId: optionalString(values, 'trusted-user-id'),
        enabled: values.enable === true,
      });
    case 'check-oauth':
      return checkOAuthAppSettings({
        clientId: requiredString(values, 'client-id'),
        redirectUri: requiredString(values, 'redirect-uri'),
        allowedScopeBits: requiredString(values, 'allowed-scope-bits'),
      });
    default:
      throw new Error('Expected one of: lookup, plan, check-oauth');
  }
}

async function main(): Promise<void> {
  try {
    const result = await runOperatorCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Operator command failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
