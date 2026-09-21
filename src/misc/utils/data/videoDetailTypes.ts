export interface VideoDetails {
  title: string;
  channelName: string;
  timestamp: string;
  image: string | undefined;
  embed: string | null;
  channelId?: string | null;
}
