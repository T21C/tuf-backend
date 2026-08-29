export type ModUserSummary = {
  userId: string;
  playerId: number | null;
  name: string;
  username: string | null;
};

export function displayNameForUser(user: {
  id: string;
  username?: string | null;
  nickname?: string | null;
}): string {
  const nickname = typeof user.nickname === 'string' ? user.nickname.trim() : '';
  if (nickname) return nickname;
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  if (username) return username;
  return user.id;
}

export function userSummaryFromUser(user: {
  id: string;
  playerId?: number | null;
  username?: string | null;
  nickname?: string | null;
}): ModUserSummary {
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  return {
    userId: user.id,
    playerId: user.playerId ?? null,
    name: displayNameForUser(user),
    username: username || null,
  };
}
