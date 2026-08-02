export interface Enclosure {
  url: string;
  length?: number;
  type?: string;
}

export interface ItunesChannel {
  author?: string;
  image?: string;
  summary?: string;
  ownerName?: string;
  ownerEmail?: string;
  explicit?: "yes" | "no";
  type?: "episodic" | "serial";
  categories?: string[];
}

export interface ItunesItem {
  duration?: string;
  image?: string;
  explicit?: "yes" | "no";
  episode?: number;
  season?: number;
  episodeType?: "full" | "trailer" | "bonus";
}

export interface PodcastPerson {
  name: string;
  role?: string;
  group?: string;
  img?: string;
  href?: string;
}

export interface PodcastFunding {
  url: string;
  message?: string;
}

export interface PodcastLocation {
  name: string;
  geo?: string;
  osm?: string;
}

export interface PodcastValueRecipient {
  name?: string;
  address: string;
  type: string;
  split: number;
  fee?: boolean;
}

export interface PodcastValue {
  type: string;
  method: string;
  suggested?: number;
  recipients: PodcastValueRecipient[];
}

export interface PodcastChannelMeta {
  guid?: string;
  locked?: "yes" | "no";
  lockedOwner?: string;
  medium?: string;
  persons?: PodcastPerson[];
  funding?: PodcastFunding[];
  location?: PodcastLocation;
  value?: PodcastValue;
}

export interface PodcastTranscript {
  url: string;
  type: string;
  language?: string;
  rel?: string;
}

export interface PodcastItemMeta {
  chaptersUrl?: string;
  transcripts?: PodcastTranscript[];
  persons?: PodcastPerson[];
  episode?: number;
  season?: number;
}
