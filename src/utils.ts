import fs from 'fs';
import path from 'path';

export type ChannelType = 'SFW' | 'NSFW';

export interface ChannelConfig {
  tags: string[];
  authorIds: number[];
  interval: IntervalKey;
  channelId: string;
  discussionChatId?: string;
  customMode?: 'daily' | 'once';
  customTime?: string;
  customDateTime?: string;
  enabled: boolean;
  recentPixivIds: number[];
}

export type IntervalKey = '5m' | '10m' | '30m' | '1h' | '3h' | '4h' | '6h' | '24h' | 'custom';

export const INTERVAL_TO_CRON: Record<IntervalKey, string> = {
  '5m': '*/5 * * * *',
  '10m': '*/10 * * * *',
  '30m': '*/30 * * * *',
  '1h': '0 * * * *',
  '3h': '0 */3 * * *',
  '4h': '0 */4 * * *',
  '6h': '0 */6 * * *',
  '24h': '0 0 * * *',
  custom: '0 0 * * *'
};

export const INTERVAL_LABELS: Record<IntervalKey, string> = {
  '5m': 'Каждые 5 минут',
  '10m': 'Каждые 10 минут',
  '30m': 'Каждые 30 минут',
  '1h': 'Каждый час',
  '3h': 'Каждые 3 часа',
  '4h': 'Каждые 4 часа',
  '6h': 'Каждые 6 часов',
  '24h': 'Каждый день',
  custom: 'Своё время'
};

const DATA_DIR = path.resolve(process.cwd(), 'data');

const CONFIG_FILES: Record<ChannelType, string> = {
  SFW: path.join(DATA_DIR, 'sfw.json'),
  NSFW: path.join(DATA_DIR, 'nsfw.json')
};

const DEFAULT_CONFIG = (channelId: string): ChannelConfig => ({
  tags: [],
  authorIds: [],
  interval: '1h',
  channelId,
  discussionChatId: undefined,
  enabled: false,
  recentPixivIds: []
});

export function logInfo(message: string): void {
  console.log(`[${new Date().toISOString()}] INFO: ${message}`);
}

export function logError(message: string, error?: unknown): void {
  console.error(`[${new Date().toISOString()}] ERROR: ${message}`);
  if (error) {
    console.error(error);
  }
}

export function ensureDataFiles(sfwChannelId: string, nsfwChannelId: string): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(CONFIG_FILES.SFW)) {
    writeConfig('SFW', DEFAULT_CONFIG(sfwChannelId));
  }

  if (!fs.existsSync(CONFIG_FILES.NSFW)) {
    writeConfig('NSFW', DEFAULT_CONFIG(nsfwChannelId));
  }
}

export function readConfig(channel: ChannelType): ChannelConfig {
  const configPath = CONFIG_FILES[channel];
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as ChannelConfig;

  return {
    tags: parsed.tags || [],
    authorIds: (parsed as any).authorIds || [],
    interval: parsed.interval || '1h',
    channelId: parsed.channelId,
    discussionChatId: (parsed as any).discussionChatId,
    customMode: (parsed as any).customMode,
    customTime: (parsed as any).customTime,
    customDateTime: (parsed as any).customDateTime,
    enabled: Boolean(parsed.enabled),
    recentPixivIds: parsed.recentPixivIds || []
  };
}

export function writeConfig(channel: ChannelType, config: ChannelConfig): void {
  const configPath = CONFIG_FILES[channel];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function updateRecentIds(recentIds: number[], newId: number, maxSize = 100): number[] {
  const filtered = recentIds.filter((id) => id !== newId);
  filtered.unshift(newId);
  return filtered.slice(0, maxSize);
}

export function parseAdminIds(raw: string | undefined): number[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id));
}

export function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function randomPick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
