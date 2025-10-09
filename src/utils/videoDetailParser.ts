import twemoji from 'twemoji';
import axios from 'axios';
import { logger } from '../services/LoggerService.js';

export interface VideoDetails {
  title: string;
  channelName: string;
  timestamp: string;
  image: string | undefined;
  embed: string | null;
  downloadLink: string | null;
}

interface BilibiliData {
  aid: string;
  bvid: string;
  cid: string;
  pubdate: number;
  pic: string;
  title: string;
  owner: {
    name: string;
    face: string;
  };
}

interface YouTubeResponse {
  items: Array<{
    snippet: {
      thumbnails: {
        maxres: {
          url: string;
          width: number;
          height: number;
        };
        high: {
          url: string;
          width: number;
          height: number;
        };
        medium: {
          url: string;
          width: number;
          height: number;
        };
        default: {
          url: string;
          width: number;
          height: number;
        };
      };
      channelId: string;
      title: string;
      channelTitle: string;
      publishedAt: string;
      description: string;
    };
  }>;
}

interface YouTubeChannelResponse {
  items: Array<{
    snippet: {
      thumbnails: {
        default: {
          url: string;
        };
      };
    };
  }>;
}

const ownUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

function getBilibiliEmbedUrl(data: BilibiliData): string | null {
  const {aid, bvid, cid} = data;

  if (bvid) {
    return `//player.bilibili.com/player.html?isOutside=true&aid=${aid}&bvid=${bvid}&cid=${cid}&p=1`;
  }
  return null;
}

function getYouTubeEmbedUrl(url: string): string | null {
  const shortUrlRegex = /youtu\.be\/([a-zA-Z0-9_-]{11})/;
  const longUrlRegex = /youtube\.com\/.*[?&]v=([a-zA-Z0-9_-]{11})/;
  const timestampRegex = /[?&]t=(\d+)s/;

  const shortMatch = url.match(shortUrlRegex);
  const longMatch = url.match(longUrlRegex);
  const timestampMatch = url.match(timestampRegex);

  const videoId = shortMatch ? shortMatch[1] : longMatch ? longMatch[1] : null;
  const timestamp = timestampMatch ? timestampMatch[1] : null;

  if (videoId) {
    let embedUrl = `https://www.youtube.com/embed/${videoId}`;
    if (timestamp) {
      embedUrl += `?start=${timestamp}`;
    }
    return embedUrl;
  }
  return null;
}

async function getBilibiliVideoDetails(
  url: string,
): Promise<VideoDetails | null> {
  const urlRegex =
    /https?:\/\/(www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)\/?/;
  const match = url.match(urlRegex);
  const videoId = match ? match[2] : null;

  if (!videoId) {
    return null;
  }

  const IMAGE_API = `${ownUrlEnv}${process.env.IMAGE_API}`;
  const BILIBILI_API = `https://api.bilibili.com/x/web-interface/view`;

  try {
    const response = await axios.get<{data: BilibiliData}>(`${BILIBILI_API}?bvid=${videoId}`);
    if (response.status !== 200) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const {data} = response.data;
    const unix = data.pubdate;
    const date = new Date(unix * 1000);
    const imageUrl = `${IMAGE_API}?url=${encodeURIComponent(data.pic)}`;
    // const pfpUrl = `${IMAGE_API}?url=${encodeURIComponent(data.owner.face)}`;

    return {
      title: data.title,
      channelName: data.owner.name,
      timestamp: date.toISOString(),
      image: imageUrl,
      embed: getBilibiliEmbedUrl(data),
      downloadLink: null,
    };
  } catch (error) {
    logger.debug('Error fetching Bilibili video details:', error);
    return null;
  }
}

async function getYouTubeVideoDetails(
  url: string,
): Promise<VideoDetails | null> {
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

  try {
    const response = await axios.get<YouTubeResponse>(apiUrl);
    const data = response.data;
    if (!data.items?.length) {
      return null;
    }

    return {
      title: data.items[0].snippet.title,
      channelName: data.items[0].snippet.channelTitle,
      timestamp: data.items[0].snippet.publishedAt,
      image:
        data.items[0].snippet.thumbnails?.maxres?.url ||
        data.items[0].snippet.thumbnails?.high?.url ||
        data.items[0].snippet.thumbnails?.medium?.url ||
        data.items[0].snippet.thumbnails?.default?.url,
      embed: getYouTubeEmbedUrl(url),
      downloadLink: (await getDriveFromYt(url, data))?.drive || null,
    };
  } catch (error) {
    logger.error('Error fetching YouTube video details:', error);
    return null;
  }
}

async function getVideoDetails(url: string): Promise<VideoDetails | null> {
  if (!url) {
    return null;
  }

  const details = await getYouTubeVideoDetails(url);
  if (!details) {
    return await getBilibiliVideoDetails(url);
  }
  return details;
}

interface DriveResult {
  drive: string | null;
  desc: string | null;
}

async function getDriveFromYt(link: string, response: YouTubeResponse | null = null): Promise<DriveResult | null> {
  let yoon = '';
  let drive = '';
  let dsc: string | null = null;
  let id = '';

  if (!link) {
    return null;
  } else if (link.split('/')[0].includes('youtu.be')) {
    id = link.split('/').join(',').split('?').join(',').split(',')[1];
  } else if (link.split('/')[2].includes('youtu.be')) {
    id = link.split('/').join(',').split('?').join(',').split(',')[3];
  } else {
    id = link.split('?v=')[1];
  }

  try {
    if (!response) {
      response = await axios.get<YouTubeResponse>(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${process.env.YOUTUBE_API_KEY}`,
      ).then(res => res.data);
    }
    const data = response!;

    if (data.items?.[0]) {
      const desc = data.items[0].snippet.description;
      if (!desc) {
        return { drive: null, desc: null };
      }
      const format = desc.split('\n').join(',').split('/').join(',').split(',');
      dsc = desc;

      if (desc.includes('drive.google.com/file/d')) {
        for (let i = 0; i < format.length; i++) {
          if (format[i].includes('drive.google.com')) {
            drive += `https://${format[i]}/file/d/${format[i + 3]}/${format[i + 4]}\n`;
          }
        }
      }

      if (desc.includes('hyonsu.com/') || desc.includes('cdn.discordapp.com')) {
        for (let i = 0; i < format.length; i++) {
          if (format[i].includes('hyonsu.com')) {
            yoon += `https://${format[i]}/attachments/${format[i + 2]}/${format[i + 3]}/${format[i + 4]}\n`;
          } else if (format[i].includes('cdn.discordapp.com')) {
            yoon += `https://fixcdn.hyonsu.com/attachments/${format[i + 2]}/${format[i + 3]}/${format[i + 4]}\n`;
          }
        }
      }

      return {
        drive: drive || yoon,
        desc: dsc,
      };
    }
  } catch (error) {
    logger.error('Error fetching YouTube video details:', error);
    return null;
  }

  return null;
}

function isoToEmoji(code: string): string | null {
  const htmlString = twemoji.parse(
    code
      .toLowerCase()
      .split('')
      .map((letter: string) => (letter.charCodeAt(0) % 32) + 0x1f1e5)
      .map((n: number) => String.fromCodePoint(n))
      .join(''),
  );

  const srcRegex = /src\s*=\s*"(.+?)"/;
  const match = htmlString.match(srcRegex);

  return match ? match[1] : null;
}

export {getYouTubeVideoDetails, getDriveFromYt, isoToEmoji, getVideoDetails};
