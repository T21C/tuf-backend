import fetch from 'node-fetch';

export const verifyAccessToken = async (accessToken) => {
    try {
      const tokenInfoResponse = await fetch('https://discord.com/api/users/@me', {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });
      //console.log(tokenInfoResponse);
      
      if (!tokenInfoResponse.ok) {
        return false; // Invalid token
      }
  
      const tokenInfo = await tokenInfoResponse.json();
      return tokenInfo; // Return the profile information if the token is valid
    } catch (error) {
      console.error('Error verifying token:', error);
      return false; // Return false on error
    }
  };
  