import fetch from 'node-fetch';

interface DiscordUserInfo {
  id: string;
  username: string;
  avatar: string | null;
}

export async function fetchDiscordUserInfo(userId: string): Promise<{
  username: string;
  avatar: string | null;
}> {
  const response = await fetch(`https://discord.com/api/v10/users/${userId}`, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Discord user info: ${response.statusText}`);
  }

  const data = (await response.json()) as DiscordUserInfo;
  
  return {
    username: data.username,
    avatar: data.avatar ? `https://cdn.discord.com/avatars/${userId}/${data.avatar}.png` : null
  };
} 