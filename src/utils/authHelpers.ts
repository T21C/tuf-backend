import axios from 'axios';

export const verifyAccessToken = async (accessToken: string) => {
  try {
    const tokenInfoResponse = await axios.get(
      'https://discord.com/api/users/@me',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (tokenInfoResponse.status !== 200) {
      return false; // Invalid token
    }

    const tokenInfo = tokenInfoResponse.data;
    return tokenInfo; // Return the profile information if the token is valid
  } catch (error) {
    console.error('Error verifying token:', error);
    return false; // Return false on error
  }
};
