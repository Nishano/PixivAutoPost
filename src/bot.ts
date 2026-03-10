import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { AdminService } from './admin';
import { AdminRegistry } from './admin-registry';
import { DiscussionTracker } from './discussion';
import { PixivService } from './pixiv';
import { PosterService } from './poster';
import { SchedulerService } from './scheduler';
import { ensureDataFiles, logError, logInfo, parseAdminIds } from './utils';

dotenv.config();

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env variable: ${name}`);
  }

  return value;
}

async function bootstrap(): Promise<void> {
  const botToken = getEnv('BOT_TOKEN');
  const pixivRefreshToken = getEnv('PIXIV_REFRESH_TOKEN');
  const pixivAccessToken = process.env.PIXIV_ACCESS_TOKEN;
  const sfwChannelId = getEnv('SFW_CHANNEL_ID');
  const nsfwChannelId = getEnv('NSFW_CHANNEL_ID');
  const adminIds = parseAdminIds(process.env.ADMIN_IDS);
  const protectedAdmins = parseAdminIds(process.env.PROTECTED_ADMIN_IDS || process.env.ADMIN_IDS);

  const merged = Array.from(new Set([...adminIds, ...protectedAdmins]));

  ensureDataFiles(sfwChannelId, nsfwChannelId);

  const bot = new Telegraf(botToken);
  const adminRegistry = new AdminRegistry(merged, protectedAdmins);
  const discussionTracker = new DiscussionTracker();
  const pixivService = new PixivService(pixivRefreshToken, pixivAccessToken);
  const posterService = new PosterService(bot.telegram, pixivService, discussionTracker);
  const schedulerService = new SchedulerService(posterService);
  const adminService = new AdminService(bot, adminRegistry, posterService, schedulerService);

  bot.on('message', async (ctx, next) => {
    discussionTracker.noteMessage((ctx as any).message);
    await next();
  });

  adminService.registerHandlers();
  schedulerService.start();

  bot.catch((error) => {
    logError('Unhandled bot error', error);
  });

  await bot.launch();
  logInfo('Telegram bot started');

  process.once('SIGINT', () => {
    bot.stop('SIGINT');
  });

  process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
  });
}

bootstrap().catch((error) => {
  logError('Fatal startup error', error);
  process.exit(1);
});
