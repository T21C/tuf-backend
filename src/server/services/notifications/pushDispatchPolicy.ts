export function shouldDropPushSubscription(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

export function shouldSendPush(args: {
  pushAvailable: boolean;
  pushEnabled: boolean;
  inApp: boolean;
  categoryInApp: boolean;
  overHourlyCap: boolean;
}): boolean {
  return (
    args.pushAvailable &&
    args.pushEnabled &&
    args.inApp &&
    args.categoryInApp &&
    !args.overHourlyCap
  );
}

export function webPushStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as {statusCode?: unknown; status?: unknown};
  if (typeof record.statusCode === 'number') return record.statusCode;
  if (typeof record.status === 'number') return record.status;
  return undefined;
}
