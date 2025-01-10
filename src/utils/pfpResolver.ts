// videoDetails.js
import dotenv from 'dotenv';
import axios, {type AxiosError} from 'axios';
dotenv.config();

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second
const ENABLE_FETCHING = true;

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getBilibiliVideoDetails(
  url: string,
  retryCount = 0,
): Promise<string | null> {
  const urlRegex =
    /https?:\/\/(www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)\/?/;
  const match = url.match(urlRegex);
  const videoId = match ? match[2] : null;

  if (!videoId) {
    return null;
  }

  const apiUrl = `${process.env.OWN_URL}/v2/media/bilibili?bvid=${videoId}`;
  try {
    const response = await axios.get(apiUrl);
    const resp = response.data;

    if (response.status === -400) {
      return null;
    }

    const data = resp.data;
    const pfpUrl = `${process.env.OWN_URL}/v2/media/image-proxy?url=${encodeURIComponent(
      data.owner.face,
    )}`;

    return pfpUrl;
  } catch (error) {
    if (error instanceof Error) {
      // If it's a 502 error and we haven't exceeded retries, try again
      if (
        retryCount < MAX_RETRIES &&
        ((error as any).response?.status === 502 ||
          (error as any).response?.status === 503)
      ) {
        console.log(
          `Retrying Bilibili API call (attempt ${retryCount + 1}/${MAX_RETRIES})...`,
        );
        await delay(RETRY_DELAY * (retryCount + 1)); // Exponential backoff
        return getBilibiliVideoDetails(url, retryCount + 1);
      }

      console.error(
        `Error fetching Bilibili video details (attempt ${retryCount + 1}/${MAX_RETRIES}):`,
        error.message,
      );
    }
    return null;
  }
}

async function getYouTubeVideoDetails(url: string): Promise<string | null> {
  const shortUrlRegex = /youtu\.be\/([a-zA-Z0-9_-]{11})/;
  const longUrlRegex = /youtube\.com\/.*[?&]v=([a-zA-Z0-9_-]{11})/;

  const shortMatch = url.match(shortUrlRegex);
  const longMatch = url.match(longUrlRegex);

  const videoId = shortMatch ? shortMatch[1] : longMatch ? longMatch[1] : null;

  if (!videoId) {
    return null;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet,contentDetails`;
  const channelApiUrl = 'https://www.googleapis.com/youtube/v3/channels';

  try {
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data.items.length === 0) {
      return null;
    }

    const channelId = data.items[0].snippet.channelId;
    const channelResponse = await axios.get(
      `${channelApiUrl}?id=${channelId}&key=${apiKey}&part=snippet`,
    );
    const channelData = channelResponse.data;

    return channelData.items[0].snippet.thumbnails.default.url;
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error fetching YouTube video details:', error.message);
    }
    return null;
  }
}

export async function getPfpUrl(url: string): Promise<string | null> {
  if (!url || !ENABLE_FETCHING) {
    return null;
  }

  // Try YouTube first as it doesn't require our server endpoints
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const details = await getYouTubeVideoDetails(url);
    if (details) return details;
  }

  // Then try Bilibili if it's a Bilibili URL
  if (url.includes('bilibili.com')) {
    const details = await getBilibiliVideoDetails(url);
    if (details) return details;
  }

  return null;
}
