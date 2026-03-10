import cron, { ScheduledTask } from 'node-cron';
import { PosterService } from './poster';
import {
  ChannelType,
  INTERVAL_TO_CRON,
  logError,
  logInfo,
  readConfig,
  writeConfig
} from './utils';

export class SchedulerService {
  private jobs = new Map<ChannelType, { stop: () => void }>();

  constructor(private readonly posterService: PosterService) {}

  start(): void {
    this.restartForChannel('SFW');
    this.restartForChannel('NSFW');
  }

  restartForChannel(channel: ChannelType): void {
    const existing = this.jobs.get(channel);
    if (existing) {
      existing.stop();
      this.jobs.delete(channel);
    }

    const config = readConfig(channel);
    if (!config.enabled) {
      logInfo(`Autopost disabled for ${channel}`);
      return;
    }

    if (config.interval === 'custom') {
      const custom = this.createCustomJob(channel);
      if (custom) {
        this.jobs.set(channel, custom.job);
        logInfo(`Autopost enabled for ${channel}: ${custom.label}`);
      } else {
        logError(`Custom schedule is invalid for ${channel}`);
      }
      return;
    }

    const expression = INTERVAL_TO_CRON[config.interval];
    const cronTask: ScheduledTask = cron.schedule(expression, async () => {
      try {
        await this.posterService.postRandomArtwork(channel);
      } catch (error) {
        logError(`Scheduled posting failed for ${channel}`, error);
      }
    });

    this.jobs.set(channel, {
      stop: () => {
        cronTask.stop();
        if (typeof (cronTask as any).destroy === 'function') {
          (cronTask as any).destroy();
        }
      }
    });
    logInfo(`Autopost enabled for ${channel}: ${expression}`);
  }

  private createCustomJob(channel: ChannelType): { job: { stop: () => void }; label: string } | null {
    const config = readConfig(channel);

    if (config.customMode === 'daily' && config.customTime) {
      const parsed = this.parseTime(config.customTime);
      if (!parsed) return null;

      const expression = `${parsed.minute} ${parsed.hour} * * *`;
      const cronTask: ScheduledTask = cron.schedule(expression, async () => {
        try {
          await this.posterService.postRandomArtwork(channel);
        } catch (error) {
          logError(`Scheduled custom(daily) posting failed for ${channel}`, error);
        }
      });

      return {
        job: {
          stop: () => {
            cronTask.stop();
            if (typeof (cronTask as any).destroy === 'function') {
              (cronTask as any).destroy();
            }
          }
        },
        label: `daily ${config.customTime}`
      };
    }

    if (config.customMode === 'once' && config.customDateTime) {
      const target = new Date(config.customDateTime);
      const delay = target.getTime() - Date.now();
      if (!Number.isFinite(delay) || delay <= 0) {
        return null;
      }

      const timeout = setTimeout(async () => {
        try {
          await this.posterService.postRandomArtwork(channel);
        } catch (error) {
          logError(`Scheduled custom(once) posting failed for ${channel}`, error);
        } finally {
          const fresh = readConfig(channel);
          fresh.enabled = false;
          writeConfig(channel, fresh);
          this.restartForChannel(channel);
        }
      }, delay);

      return {
        job: {
          stop: () => clearTimeout(timeout)
        },
        label: `once ${config.customDateTime}`
      };
    }

    return null;
  }

  private parseTime(raw: string): { hour: number; minute: number } | null {
    const m = raw.match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }
}
