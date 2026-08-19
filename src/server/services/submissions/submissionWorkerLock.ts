export const SUBMISSION_WORKER_LOCK_KEY = 'submission:worker:lock';
export const SUBMISSION_WORKER_LOCK_TTL_SECONDS = 180;

const LOCK_REFRESH_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const LOCK_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function acquireSubmissionWorkerLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  token: string,
  ttlSeconds = SUBMISSION_WORKER_LOCK_TTL_SECONDS,
): Promise<boolean> {
  const result = await client.set(SUBMISSION_WORKER_LOCK_KEY, token, {
    NX: true,
    EX: ttlSeconds,
  });
  return result === 'OK';
}

export async function refreshSubmissionWorkerLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  token: string,
  ttlSeconds = SUBMISSION_WORKER_LOCK_TTL_SECONDS,
): Promise<boolean> {
  const result = await client.eval(LOCK_REFRESH_SCRIPT, {
    keys: [SUBMISSION_WORKER_LOCK_KEY],
    arguments: [token, String(ttlSeconds)],
  });
  return result === 1;
}

export async function releaseSubmissionWorkerLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  token: string,
): Promise<void> {
  await client.eval(LOCK_RELEASE_SCRIPT, {
    keys: [SUBMISSION_WORKER_LOCK_KEY],
    arguments: [token],
  });
}
