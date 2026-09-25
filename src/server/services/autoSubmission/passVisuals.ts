import { z } from 'zod';
import { readInternalTokens } from './internalTokens.js';

export const visualDefaultsSchema = z.object({
  keyviewer_id: z.uuid().nullable(),
  overlay_id: z.uuid().nullable(),
}).strict();
export const visualOptionsSchema = z.object({
  defaults: visualDefaultsSchema,
  presets: z.array(z.object({
    id: z.uuid(), name: z.string().max(200), kind: z.enum(['keyviewer', 'overlay']),
    source: z.string().max(100), is_hidden: z.boolean(),
  }).strict()),
}).strict();

export function ownsReplayPass(
  user: { id: string; playerId?: number | null } | undefined,
  pass: { playerId: number; autoSubmissionRunId?: string | null; isDeleted?: boolean | null } | null,
): boolean {
  return !!user && !!pass && !pass.isDeleted && !!user.playerId &&
    user.playerId === pass.playerId && z.uuid().safeParse(pass.autoSubmissionRunId).success;
}

export async function requestPassVisuals(input: {
  runId: string; passId: number; ownerId: string;
  operation: 'read' | 'defaults' | 'visibility';
  defaults?: z.infer<typeof visualDefaultsSchema>; presetId?: string; hidden?: boolean;
}, fetcher: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env) {
  const tokens = readInternalTokens(env);
  const base = env.AUTO_SUBMISSION_API_URL;
  if (!tokens || !base) throw { code: 503, error: 'Replay visual settings are unavailable. Try again later.' };
  const run = z.uuid().parse(input.runId);
  const owner_id = z.uuid().parse(input.ownerId);
  const pass_id = z.number().int().positive().parse(input.passId);
  const root = `/internal/tuf/replays/${run}/visuals`;
  const url = new URL(input.operation === 'visibility'
    ? `${root}/${z.uuid().parse(input.presetId)}/visibility` : root, base);
  let body: object | undefined;
  if (input.operation === 'read') {
    url.searchParams.set('owner_id', owner_id);
    url.searchParams.set('pass_id', String(pass_id));
  } else if (input.operation === 'defaults') {
    body = { owner_id, pass_id, defaults: visualDefaultsSchema.parse(input.defaults) };
  } else {
    body = { owner_id, pass_id, hidden: z.boolean().parse(input.hidden) };
  }
  const response = await fetcher(url, {
    method: body ? 'PUT' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${tokens.outgoing}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const code = response.status === 404 ? 404 : response.status === 400 ? 400 : 503;
    throw { code, error: code === 400 ? 'That visual is no longer available. Reload the settings and choose again.'
      : code === 404 ? 'Replay visual settings were not found for this account.'
      : 'Replay visual settings are unavailable. Try again later.' };
  }
  return visualOptionsSchema.parse(await response.json());
}
