// videoDetails.js
import dotenv from 'dotenv';
import axios, {type AxiosError} from 'axios';
dotenv.config();

async function getBilibiliVideoDetails(url: string) {
  const urlRegex =
    /https?:\/\/(www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)\/?/;
  const match = url.match(urlRegex);
  const videoId = match ? match[2] : null;

  if (!videoId) {
    return null;
  }

  const apiUrl = `${process.env.OWN_URL}/api/bilibili?bvid=${videoId}`;
  console.log('apiUrl', apiUrl);
  try {
    const response = await axios.get(apiUrl).catch((error: AxiosError) => {
      throw new Error(`HTTP error! Status: ${error.status}`);
    });

    const resp = response.data;

    if (response.status === -400) {
      return null;
    }

    const data = resp.data;
    const pfpUrl = `${process.env.OWN_URL}/media/image?url=${encodeURIComponent(
      data.owner.face,
    )}`;

    return pfpUrl;
  } catch (error) {
    console.error('Error fetching Bilibili video details:', error);
    return null;
  }
}

async function getYouTubeVideoDetails(url: string) {
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
    console.error('Error fetching YouTube video details:', error);
    return null;
  }
}

export async function getPfpUrl(url: string) {
  if (!url) {
    return null;
  }

  let details = await getYouTubeVideoDetails(url);
  if (!details) {
    details = await getBilibiliVideoDetails(url);
  }

  return details;
}
