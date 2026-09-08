export function shouldHideOwnActivityNotification(args: {
  actorId?: string | null;
  userId: string;
  hideOwnActivity?: boolean | null;
}): boolean {
  if (!args.hideOwnActivity) return false;
  if (!args.actorId) return false;
  return args.userId === args.actorId;
}
