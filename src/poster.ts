import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Input, Telegram } from 'telegraf';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import AdmZip from 'adm-zip';
import { DiscussionTarget, DiscussionTracker } from './discussion';
import { PixivArtwork, PixivService } from './pixiv';
import {
  ChannelConfig,
  ChannelType,
  logError,
  logInfo,
  readConfig,
  updateRecentIds,
  writeConfig
} from './utils';

type ReplyDocumentSource = { source: 'path' | 'file_id'; value: string };
type PixivPageSelectionMode = 'leading' | 'random';

export class PosterService {
  private static readonly MEDIA_GROUP_LIMIT = 10;
  private static readonly TELEGRAM_PHOTO_MAX_FILE_BYTES = 10 * 1024 * 1024;
  private static readonly TELEGRAM_PHOTO_TARGET_FILE_BYTES = 9_500_000;
  private static readonly TELEGRAM_PHOTO_MAX_SIDE = 5000;
  private static readonly ORIGINAL_REPLY_RETRY_DELAYS_MS = [5000, 5000, 10000, 30000];
  private static readonly TELEGRAM_RATE_LIMIT_MAX_RETRIES = 4;

  // было 1500
  private static readonly ORIGINAL_REPLY_TARGET_WAIT_MS = 5000;

  private readonly execFileAsync = promisify(execFile);
  private readonly lastAuthorByChannel = new Map<ChannelType, number>();
  private readonly originalReplyQueueByChannel = new Map<string, Promise<void>>();

  constructor(
    private readonly telegram: Telegram,
    private readonly pixivService: PixivService,
    private readonly discussionTracker: DiscussionTracker
  ) {}

  async postRandomArtwork(channel: ChannelType): Promise<void> {
    const config = readConfig(channel);
    await this.postRandomArtworkWithConfig(channel, config);
  }

  async inspectPixivArtwork(
    artworkId: number
  ): Promise<{ id: number; artist: string; pageCount: number; isUgoira: boolean; isNsfw: boolean }> {
    const artwork = await this.pixivService.getArtworkById(artworkId);
    return {
      id: artwork.id,
      artist: artwork.artist,
      pageCount: artwork.pageCount,
      isUgoira: artwork.isUgoira,
      isNsfw: artwork.isNsfw
    };
  }

  async postRandomArtworkWithConfig(channel: ChannelType, config: ChannelConfig): Promise<void> {
    const photoFiles: string[] = [];
    const originalFiles: string[] = [];
    const generatedPhotoFiles: string[] = [];
    let ugoiraGifPath: string | null = null;
    let ugoiraFramesArchivePath: string | null = null;
    let originalReplyScheduled = false;

    try {
      const artwork = await this.pickRandomArtworkWithBalance(channel, config, true);

      if (artwork.isUgoira) {
        const assets = await this.buildUgoiraAssets(artwork.id, artwork.ugoiraZipUrl!, artwork.ugoiraFrames!);
        const gifPath = assets.gifPath;
        ugoiraGifPath = gifPath;
        ugoiraFramesArchivePath = assets.framesArchivePath;

        const postUrl = `https://www.pixiv.net/artworks/${artwork.id}`;
        const caption = [
          this.formatAuthorLine(artwork.artist),
          `Ссылка: <a href="${postUrl}">Pixiv пост</a>`
        ].join('\n');

        const msg = await this.telegram.sendAnimation(
          config.channelId,
          Input.fromLocalFile(gifPath),
          { caption, parse_mode: 'HTML' }
        );

        this.discussionTracker.registerPending(config.channelId, msg.message_id);

        this.startOriginalReplyTask(
          channel,
          config,
          msg.message_id,
          [{ source: 'path', value: assets.framesArchivePath }],
          'Кадры GIF (tar.gz)',
          () => {
            this.safeRemoveFile(assets.framesArchivePath);
          }
        );
        originalReplyScheduled = true;

        config.recentPixivIds = updateRecentIds(config.recentPixivIds, artwork.id);
        writeConfig(channel, config);
        if (artwork.authorId > 0) this.lastAuthorByChannel.set(channel, artwork.authorId);
        logInfo(`Posted Pixiv ugoira ${artwork.id} to ${channel}`);
        return;
      }

      const totalPages = artwork.originalUrls.length;
      if (!totalPages) {
        throw new Error(`Artwork ${artwork.id} has no pages.`);
      }

      const pageIndexes = this.pickPageIndexes(totalPages);
      for (const idx of pageIndexes) {
        originalFiles.push(await this.pixivService.downloadOriginalImage(artwork.originalUrls[idx]));
      }

      const preparedPhotos = await this.preparePhotosForChannelPost(originalFiles);
      photoFiles.push(...preparedPhotos.photoFiles);
      generatedPhotoFiles.push(...preparedPhotos.generatedFiles);

      const postUrl = `https://www.pixiv.net/artworks/${artwork.id}`;
      const infoCaption = [
        this.formatAuthorLine(artwork.artist),
        `Ссылка: <a href="${postUrl}">Pixiv пост</a>`
      ].join('\n');

      const mainMessageId = await this.sendPreviewPost(config.channelId, photoFiles, infoCaption);
      this.discussionTracker.registerPending(config.channelId, mainMessageId);

      this.startOriginalReplyTask(
        channel,
        config,
        mainMessageId,
        originalFiles.map((file) => ({ source: 'path' as const, value: file })),
        undefined,
        () => {
          originalFiles.forEach((file) => this.safeRemoveFile(file));
        }
      );
      originalReplyScheduled = true;

      config.recentPixivIds = updateRecentIds(config.recentPixivIds, artwork.id);
      writeConfig(channel, config);

      if (artwork.authorId > 0) this.lastAuthorByChannel.set(channel, artwork.authorId);
      logInfo(`Posted Pixiv artwork ${artwork.id} (${pageIndexes.length}/${totalPages}) to ${channel}`);
    } catch (error) {
      logError(`Failed to post artwork to ${channel}`, error);
      throw error;
    } finally {
      if (!originalReplyScheduled) {
        originalFiles.forEach((file) => this.safeRemoveFile(file));
      }
      generatedPhotoFiles.forEach((file) => this.safeRemoveFile(file));
      if (ugoiraGifPath) this.safeRemoveFile(ugoiraGifPath);
      if (ugoiraFramesArchivePath && !originalReplyScheduled) this.safeRemoveFile(ugoiraFramesArchivePath);
    }
  }

  async postAdminUpload(
    channel: ChannelType,
    payload:
      | { type: 'photo'; fileId: string; caption?: string }
      | { type: 'document'; fileId: string; caption?: string; mimeType?: string; fileName?: string }
      | { type: 'document_group'; fileIds: string[]; caption?: string }
      | { type: 'photo_group'; fileIds: string[]; caption?: string },
    _senderName: string,
    extraText?: string
  ): Promise<void> {
    const config = readConfig(channel);
    const parts: string[] = [];
    if (payload.caption?.trim()) parts.push(payload.caption.trim());
    if (extraText?.trim()) parts.push(extraText.trim());
    const caption = parts.length ? parts.join('\n\n') : undefined;

    const originalTempFiles: string[] = [];
    const compressedGroupTempFiles: string[] = [];
    let originalReplyScheduled = false;

    let mainMessageId: number;
    let compressedPostTempPath: string | null = null;

    if (payload.type === 'photo') {
      const mainMessage = await this.telegram.sendPhoto(
        config.channelId,
        payload.fileId,
        caption ? { caption } : {}
      );
      mainMessageId = mainMessage.message_id;
    } else if (payload.type === 'document') {
      if (this.shouldCompressDocumentForPost(payload.mimeType, payload.fileName)) {
        compressedPostTempPath = await this.downloadTelegramFileToTemp(
          payload.fileId,
          this.resolveImageExt(payload.fileName, payload.mimeType)
        );

        const mainMessage = await this.telegram.sendPhoto(
          config.channelId,
          Input.fromLocalFile(compressedPostTempPath),
          caption ? { caption } : {}
        );
        mainMessageId = mainMessage.message_id;
      } else {
        const mainMessage = await this.telegram.sendDocument(
          config.channelId,
          payload.fileId,
          caption ? { caption } : {}
        );
        mainMessageId = mainMessage.message_id;
      }
    } else if (payload.type === 'document_group') {
      for (const fileId of payload.fileIds) {
        compressedGroupTempFiles.push(await this.downloadTelegramFileToTemp(fileId, '.jpg'));
      }

      const media = compressedGroupTempFiles.map((file, idx) => (
        idx === 0
          ? (caption
            ? ({ type: 'photo' as const, media: Input.fromLocalFile(file), caption })
            : ({ type: 'photo' as const, media: Input.fromLocalFile(file) }))
          : ({ type: 'photo' as const, media: Input.fromLocalFile(file) })
      ));

      const messages = await this.telegram.sendMediaGroup(config.channelId, media as any);
      mainMessageId = this.getMediaGroupAnchorMessageId(messages);
    } else {
      const media = payload.fileIds.map((id, idx) => (
        idx === 0
          ? (caption
            ? ({ type: 'photo' as const, media: id, caption })
            : ({ type: 'photo' as const, media: id }))
          : ({ type: 'photo' as const, media: id })
      ));

      const messages = await this.telegram.sendMediaGroup(config.channelId, media as any);
      mainMessageId = this.getMediaGroupAnchorMessageId(messages);
    }

    this.discussionTracker.registerPending(config.channelId, mainMessageId);
    const originalDocs: ReplyDocumentSource[] = [];

    try {
      if (payload.type === 'photo') {
        originalTempFiles.push(await this.downloadTelegramFileToTemp(payload.fileId, '.jpg'));
        originalDocs.push(...originalTempFiles.map((file) => ({ source: 'path' as const, value: file })));
      } else if (payload.type === 'document') {
        originalDocs.push({ source: 'file_id' as const, value: payload.fileId });
      } else if (payload.type === 'document_group') {
        originalDocs.push(...payload.fileIds.map((id) => ({ source: 'file_id' as const, value: id })));
      } else {
        for (const photoId of payload.fileIds) {
          originalTempFiles.push(await this.downloadTelegramFileToTemp(photoId, '.jpg'));
        }
        originalDocs.push(...originalTempFiles.map((file) => ({ source: 'path' as const, value: file })));
      }

      this.startOriginalReplyTask(channel, config, mainMessageId, originalDocs, undefined, () => {
        originalTempFiles.forEach((file) => this.safeRemoveFile(file));
      });
      originalReplyScheduled = true;
    } finally {
      if (!originalReplyScheduled) {
        originalTempFiles.forEach((file) => this.safeRemoveFile(file));
      }
      compressedGroupTempFiles.forEach((file) => this.safeRemoveFile(file));
      if (compressedPostTempPath) this.safeRemoveFile(compressedPostTempPath);
    }

    logInfo(`Admin manual ${payload.type} post sent to ${channel}`);
  }

  async postPixivArtworkById(
    channel: ChannelType,
    artworkId: number,
    pageLimit?: number,
    enforceChannelFilter = false,
    selectionMode: PixivPageSelectionMode = 'leading'
  ): Promise<void> {
    const config = readConfig(channel);
    const artwork = await this.pixivService.getArtworkById(artworkId);

    if (enforceChannelFilter) {
      this.assertArtworkAllowedForChannel(channel, artwork);
    }

    if (artwork.isUgoira) {
      const assets = await this.buildUgoiraAssets(artwork.id, artwork.ugoiraZipUrl!, artwork.ugoiraFrames!);
      const gifPath = assets.gifPath;
      let originalReplyScheduled = false;

      try {
        const postUrl = `https://www.pixiv.net/artworks/${artwork.id}`;
        const caption = [
          this.formatAuthorLine(artwork.artist),
          `Ссылка: <a href="${postUrl}">Pixiv пост</a>`
        ].join('\n');

        const msg = await this.telegram.sendAnimation(
          config.channelId,
          Input.fromLocalFile(gifPath),
          { caption, parse_mode: 'HTML' }
        );

        this.discussionTracker.registerPending(config.channelId, msg.message_id);

        this.startOriginalReplyTask(
          channel,
          config,
          msg.message_id,
          [{ source: 'path', value: assets.framesArchivePath }],
          'Кадры GIF (tar.gz)',
          () => {
            this.safeRemoveFile(assets.framesArchivePath);
          }
        );
        originalReplyScheduled = true;

        config.recentPixivIds = updateRecentIds(config.recentPixivIds, artwork.id);
        writeConfig(channel, config);
        if (artwork.authorId > 0) this.lastAuthorByChannel.set(channel, artwork.authorId);
        logInfo(`Posted Pixiv ugoira ${artwork.id} to ${channel}`);
      } finally {
        this.safeRemoveFile(gifPath);
        if (!originalReplyScheduled) {
          this.safeRemoveFile(assets.framesArchivePath);
        }
      }
      return;
    }

    const totalPages = artwork.originalUrls.length;
    if (!totalPages) {
      throw new Error(`Artwork ${artworkId} has no pages.`);
    }

    const pageIndexes = this.pickPixivPageIndexes(totalPages, pageLimit, selectionMode);
    const pageChunks = this.chunkIndexes(pageIndexes, PosterService.MEDIA_GROUP_LIMIT);
    const postUrl = `https://www.pixiv.net/artworks/${artwork.id}`;
    const baseCaption = [
      this.formatAuthorLine(artwork.artist),
      `Ссылка: <a href="${postUrl}">Pixiv пост</a>`
    ].join('\n');

    try {
      for (let chunkIndex = 0; chunkIndex < pageChunks.length; chunkIndex += 1) {
        const chunkPageIndexes = pageChunks[chunkIndex];
        const photoFiles: string[] = [];
        const originalFiles: string[] = [];
        const generatedPhotoFiles: string[] = [];

        try {
          for (const pageIndex of chunkPageIndexes) {
            originalFiles.push(await this.pixivService.downloadOriginalImage(artwork.originalUrls[pageIndex]));
          }

          const preparedPhotos = await this.preparePhotosForChannelPost(originalFiles);
          photoFiles.push(...preparedPhotos.photoFiles);
          generatedPhotoFiles.push(...preparedPhotos.generatedFiles);

          const caption = this.formatPixivChunkCaption(baseCaption, chunkIndex, pageChunks.length);
          const mainMessageId = await this.sendPreviewPost(config.channelId, photoFiles, caption);
          this.discussionTracker.registerPending(config.channelId, mainMessageId);

          await this.sendOriginalReplyWithRetry(
            channel,
            config,
            mainMessageId,
            originalFiles.map((file) => ({ source: 'path' as const, value: file }))
          );
        } finally {
          originalFiles.forEach((file) => this.safeRemoveFile(file));
          generatedPhotoFiles.forEach((file) => this.safeRemoveFile(file));
        }
      }

      config.recentPixivIds = updateRecentIds(config.recentPixivIds, artwork.id);
      writeConfig(channel, config);
      if (artwork.authorId > 0) this.lastAuthorByChannel.set(channel, artwork.authorId);
      logInfo(`Posted Pixiv artwork ${artwork.id} (${pageIndexes.length}/${totalPages}) to ${channel} in ${pageChunks.length} post(s)`);
    } catch (error) {
      logError(`Failed posting Pixiv artwork ${artworkId} to ${channel}`, error);
      throw error;
    }
  }

  private async sendOriginalReplyWithRetry(
    channel: ChannelType,
    config: ChannelConfig,
    channelMessageId: number,
    docs: ReplyDocumentSource[],
    firstCaption?: string
  ): Promise<boolean> {
    if (!docs.length) {
      return true;
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < PosterService.ORIGINAL_REPLY_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = PosterService.ORIGINAL_REPLY_RETRY_DELAYS_MS[attempt];
      await this.sleep(delayMs);

      try {
        const discussionTarget = await this.resolveDiscussionTarget(config.channelId, channelMessageId);
        if (!discussionTarget) {
          throw new Error(`Reply target not found for post ${channelMessageId}.`);
        }

        await this.sendDocumentGroupsAsReply(
          discussionTarget.chatId,
          discussionTarget.messageId,
          docs,
          firstCaption,
          discussionTarget.messageThreadId
        );

        logInfo(`Original reply sent for ${channel} post ${channelMessageId} on attempt ${attempt + 1}`);
        return true;
      } catch (error) {
        lastError = error;
        logError(
          `Original reply attempt ${attempt + 1}/${PosterService.ORIGINAL_REPLY_RETRY_DELAYS_MS.length} failed for ${channel} post ${channelMessageId}`,
          error
        );
      }
    }

    this.discussionTracker.cancelPending(config.channelId, channelMessageId);
    logError(`Original reply cancelled for ${channel} post ${channelMessageId}`, lastError);
    return false;
  }

  private startOriginalReplyTask(
    channel: ChannelType,
    config: ChannelConfig,
    channelMessageId: number,
    docs: ReplyDocumentSource[],
    firstCaption?: string,
    onFinally?: () => void
  ): void {
    const queueKey = config.channelId;
    const previousTask = this.originalReplyQueueByChannel.get(queueKey) || Promise.resolve();
    const nextTask = previousTask
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.sendOriginalReplyWithRetry(channel, config, channelMessageId, docs, firstCaption);
        } catch (error) {
          logError(`Original reply task crashed for ${channel} post ${channelMessageId}`, error);
        } finally {
          onFinally?.();
        }
      });

    this.originalReplyQueueByChannel.set(queueKey, nextTask);
    void nextTask.finally(() => {
      if (this.originalReplyQueueByChannel.get(queueKey) === nextTask) {
        this.originalReplyQueueByChannel.delete(queueKey);
      }
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async resolveDiscussionTarget(
    channelId: string,
    channelMessageId: number
  ): Promise<DiscussionTarget | null> {
    const known = this.discussionTracker.getKnownTarget(channelId, channelMessageId);
    if (known) {
      return known;
    }

    return this.discussionTracker.waitForTarget(
      channelId,
      channelMessageId,
      PosterService.ORIGINAL_REPLY_TARGET_WAIT_MS
    );
  }

  private async downloadTelegramFileToTemp(fileId: string, defaultExt: string): Promise<string> {
    const file = await this.telegram.getFile(fileId);
    if (!file.file_path) {
      throw new Error('Telegram file path is empty');
    }

    const ext = path.extname(file.file_path) || defaultExt;
    const outputPath = path.join('/tmp', `tg-${Date.now()}-${randomUUID()}${ext}`);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: HTTP ${response.status}`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, data);
    return outputPath;
  }

  private shouldCompressDocumentForPost(mimeType?: string, fileName?: string): boolean {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) {
      return mime !== 'image/gif';
    }

    const ext = path.extname(String(fileName || '')).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext);
  }

  private resolveImageExt(fileName?: string, mimeType?: string): string {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (ext) return ext;
    const mime = String(mimeType || '').toLowerCase();
    if (mime === 'image/png') return '.png';
    if (mime === 'image/webp') return '.webp';
    return '.jpg';
  }

  private pickPageIndexes(totalPages: number, requestedCount?: number): number[] {
    if (totalPages <= 1) {
      return [0];
    }

    let targetCount: number;
    if (Number.isFinite(requestedCount) && Number(requestedCount) > 0) {
      targetCount = Math.floor(Number(requestedCount));
    } else if (totalPages >= 20) {
      targetCount = 10;
    } else {
      targetCount = this.randomInt(1, Math.min(totalPages, PosterService.MEDIA_GROUP_LIMIT));
    }

    targetCount = Math.min(targetCount, totalPages, PosterService.MEDIA_GROUP_LIMIT);
    const selected = new Set<number>();
    while (selected.size < targetCount) {
      selected.add(this.randomInt(0, totalPages - 1));
    }
    return Array.from(selected).sort((a, b) => a - b);
  }

  private pickLeadingPageIndexes(totalPages: number, requestedCount?: number): number[] {
    if (totalPages <= 1) {
      return [0];
    }

    const targetCount = Number.isFinite(requestedCount) && Number(requestedCount) > 0
      ? Math.min(Math.floor(Number(requestedCount)), totalPages)
      : totalPages;

    return Array.from({ length: targetCount }, (_, index) => index);
  }

  private pickPixivPageIndexes(
    totalPages: number,
    requestedCount?: number,
    selectionMode: PixivPageSelectionMode = 'leading'
  ): number[] {
    const targetCount = Number.isFinite(requestedCount) && Number(requestedCount) > 0
      ? Math.min(Math.floor(Number(requestedCount)), totalPages)
      : totalPages;

    if (selectionMode === 'random') {
      return this.pickRandomPageIndexes(totalPages, targetCount);
    }

    return this.pickLeadingPageIndexes(totalPages, targetCount);
  }

  private pickRandomPageIndexes(totalPages: number, targetCount: number): number[] {
    if (targetCount >= totalPages) {
      return this.pickLeadingPageIndexes(totalPages, totalPages);
    }

    const selected = new Set<number>();
    while (selected.size < targetCount) {
      selected.add(this.randomInt(0, totalPages - 1));
    }

    return Array.from(selected).sort((a, b) => a - b);
  }

  private chunkIndexes(indexes: number[], chunkSize: number): number[][] {
    const chunks: number[][] = [];

    for (let start = 0; start < indexes.length; start += chunkSize) {
      chunks.push(indexes.slice(start, start + chunkSize));
    }

    return chunks;
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private formatPixivChunkCaption(baseCaption: string, chunkIndex: number, totalChunks: number): string {
    if (totalChunks <= 1) {
      return baseCaption;
    }

    return `${baseCaption}\nЧасть ${chunkIndex + 1}/${totalChunks}`;
  }

  private formatAuthorLine(author: string): string {
    const normalized = String(author || '')
      .replace(/[^\p{L}\p{N}_]+/gu, '_')
      .replace(/^_+|_+$/g, '');
    if (!normalized) {
      return `Автор: ${author}`;
    }
    return `Автор: #${normalized}`;
  }

  private async sendPreviewPost(channelId: string, previewFiles: string[], caption: string): Promise<number> {
    if (previewFiles.length <= 1) {
      const msg = await this.withTelegramRateLimitRetry(
        () => this.telegram.sendPhoto(
          channelId,
          Input.fromLocalFile(previewFiles[0]),
          { caption, parse_mode: 'HTML' }
        ),
        `sendPhoto preview to ${channelId}`
      );
      return msg.message_id;
    }

    const media = previewFiles.map((file, idx) => (
      idx === 0
        ? ({ type: 'photo' as const, media: Input.fromLocalFile(file), caption, parse_mode: 'HTML' })
        : ({ type: 'photo' as const, media: Input.fromLocalFile(file) })
    ));

    const messages = await this.withTelegramRateLimitRetry(
      () => this.telegram.sendMediaGroup(channelId, media as any),
      `sendMediaGroup preview to ${channelId}`
    );

    // ВАЖНО: якорь для discussion у альбома — первое сообщение
    return this.getMediaGroupAnchorMessageId(messages);
  }

  private getMediaGroupAnchorMessageId(messages: Array<{ message_id: number }>): number {
    if (!messages.length) {
      throw new Error('Telegram did not return media group messages');
    }

    // было: return messages[messages.length - 1].message_id;
    return messages[0].message_id;
  }

  private async preparePhotosForChannelPost(
    originalFiles: string[]
  ): Promise<{ photoFiles: string[]; generatedFiles: string[] }> {
    const photoFiles: string[] = [];
    const generatedFiles: string[] = [];

    for (const originalFile of originalFiles) {
      const prepared = await this.preparePhotoForSendPhoto(originalFile);
      photoFiles.push(prepared);
      if (prepared !== originalFile) {
        generatedFiles.push(prepared);
      }
    }

    return { photoFiles, generatedFiles };
  }

  private async preparePhotoForSendPhoto(originalFile: string): Promise<string> {
    const ext = path.extname(originalFile).toLowerCase();
    const stat = fs.statSync(originalFile);

    if (this.isNativeSendPhotoInput(ext, stat.size)) {
      return originalFile;
    }

    return this.renderBestEffortTelegramPhoto(originalFile);
  }

  private isNativeSendPhotoInput(ext: string, sizeBytes: number): boolean {
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
      && sizeBytes <= PosterService.TELEGRAM_PHOTO_MAX_FILE_BYTES;
  }

  private async renderBestEffortTelegramPhoto(originalFile: string): Promise<string> {
    const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path || 'ffmpeg';
    const outputPath = path.join('/tmp', `pixiv-photo-${Date.now()}-${randomUUID()}.jpg`);
    const maxSides = [5000, 4500, 4096, 3500, 3072, 2560];
    const qualities = [2, 3, 4, 5, 6, 7];
    let lastError: unknown;

    try {
      for (const maxSide of maxSides) {
        for (const quality of qualities) {
          try {
            await this.execFileAsync(ffmpegPath, [
              '-v', 'error',
              '-y',
              '-i', originalFile,
              '-vf',
              [
                `scale=${Math.min(maxSide, PosterService.TELEGRAM_PHOTO_MAX_SIDE)}:${Math.min(maxSide, PosterService.TELEGRAM_PHOTO_MAX_SIDE)}:force_original_aspect_ratio=decrease`,
                'format=yuvj420p'
              ].join(','),
              '-frames:v', '1',
              '-q:v', String(quality),
              outputPath
            ]);

            if (!fs.existsSync(outputPath)) {
              throw new Error('ffmpeg did not create output photo');
            }

            if (fs.statSync(outputPath).size <= PosterService.TELEGRAM_PHOTO_TARGET_FILE_BYTES) {
              return outputPath;
            }
          } catch (error) {
            lastError = error;
          }
        }
      }

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size <= PosterService.TELEGRAM_PHOTO_MAX_FILE_BYTES) {
        return outputPath;
      }

      throw lastError || new Error('Could not fit image into Telegram sendPhoto limits');
    } catch (error: any) {
      this.safeRemoveFile(outputPath);
      const message = String(error?.message || error);
      throw new Error(`Failed to prepare high-quality photo from ${path.basename(originalFile)}. ${message}`);
    }
  }

  private async sendDocumentGroupsAsReply(
    chatId: string,
    replyToMessageId: number,
    docs: ReplyDocumentSource[],
    firstCaption?: string,
    messageThreadId?: number
  ): Promise<void> {
    if (!docs.length) return;

    const replyExtra: Record<string, unknown> = {
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: false
    };

    if (messageThreadId) {
      replyExtra.message_thread_id = messageThreadId;
    }

    if (docs.length === 1) {
      const doc = docs[0];
      const media = doc.source === 'path' ? Input.fromLocalFile(doc.value) : doc.value;

      await this.withTelegramRateLimitRetry(
        () => this.telegram.sendDocument(
          chatId,
          media as any,
          {
            ...replyExtra,
            ...(firstCaption ? { caption: firstCaption } : {})
          } as any
        ),
        `sendDocument reply to ${chatId}`
      );

      return;
    }

    for (let start = 0; start < docs.length; start += PosterService.MEDIA_GROUP_LIMIT) {
      const chunk = docs.slice(start, start + PosterService.MEDIA_GROUP_LIMIT);

      const media = chunk.map((doc, idx) => {
        const mediaValue = doc.source === 'path' ? Input.fromLocalFile(doc.value) : doc.value;

        if (start === 0 && idx === 0 && firstCaption) {
          return {
            type: 'document' as const,
            media: mediaValue,
            caption: firstCaption
          };
        }

        return {
          type: 'document' as const,
          media: mediaValue
        };
      });

      await this.withTelegramRateLimitRetry(
        () => this.telegram.sendMediaGroup(
          chatId,
          media as any,
          replyExtra as any
        ),
        `sendMediaGroup reply to ${chatId}`
      );
    }
  }

  private async withTelegramRateLimitRetry<T>(
    action: () => Promise<T>,
    label: string,
    attempts = PosterService.TELEGRAM_RATE_LIMIT_MAX_RETRIES
  ): Promise<T> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        const retryAfterMs = this.getTelegramRetryAfterMs(error);
        if (!retryAfterMs || attempt >= attempts) {
          throw error;
        }

        logInfo(`${label} hit Telegram rate limit, retry ${attempt + 1}/${attempts} in ${retryAfterMs}ms`);
        await this.sleep(retryAfterMs);
      }
    }

    throw new Error(`Unexpected retry exhaustion for ${label}`);
  }

  private getTelegramRetryAfterMs(error: unknown): number | null {
    const retryAfterSeconds = Number((error as any)?.response?.parameters?.retry_after);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      return null;
    }

    return retryAfterSeconds * 1000;
  }


  private async pickRandomArtworkWithBalance(
    channel: ChannelType,
    config: ChannelConfig,
    enforceChannelFilter: boolean
  ): Promise<PixivArtwork> {
    if (config.authorIds.length) {
      return this.pickFromAuthors(channel, config, enforceChannelFilter);
    }

    const fetchRandom = async (): Promise<PixivArtwork> => (
      this.pixivService.getRandomArtworkByTags(config.tags, config.recentPixivIds)
    );

    const gifChance = Number(process.env.UGOIRA_RANDOM_CHANCE || 0.2);
    let fallbackGif: PixivArtwork | null = null;

    for (let i = 0; i < 30; i += 1) {
      const artwork = await fetchRandom();
      if (enforceChannelFilter && !this.isArtworkAllowedForChannel(channel, artwork)) {
        continue;
      }
      if (!artwork.isUgoira) {
        return artwork;
      }
      if (!fallbackGif) fallbackGif = artwork;
      if (Math.random() < gifChance) {
        return artwork;
      }
    }

    if (!fallbackGif) {
      throw new Error(`No artwork passed strict ${channel} filter.`);
    }
    return fallbackGif;
  }

  private async pickFromAuthors(
    channel: ChannelType,
    config: ChannelConfig,
    enforceChannelFilter: boolean
  ): Promise<PixivArtwork> {
    const ids = [...config.authorIds];
    if (!ids.length) {
      throw new Error('No author IDs configured.');
    }

    const shuffle = (arr: number[]): number[] => arr.sort(() => Math.random() - 0.5);
    const lastAuthor = this.lastAuthorByChannel.get(channel);
    const preferred = shuffle(ids.filter((id) => id !== lastAuthor));
    const fallback = shuffle(ids.filter((id) => id === lastAuthor));
    const order = preferred.length ? [...preferred, ...fallback] : shuffle(ids);

    const gifChance = Number(process.env.UGOIRA_RANDOM_CHANCE || 0.2);
    let fallbackGif: PixivArtwork | null = null;
    let lastError: unknown;

    for (const authorId of order) {
      try {
        const artwork = await this.pixivService.getRandomArtworkByAuthor(authorId, config.recentPixivIds);
        if (enforceChannelFilter && !this.isArtworkAllowedForChannel(channel, artwork)) {
          continue;
        }
        if (!artwork.isUgoira) {
          return artwork;
        }
        if (!fallbackGif) fallbackGif = artwork;
        if (Math.random() < gifChance) {
          return artwork;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (fallbackGif) return fallbackGif;
    if (lastError) throw lastError;
    throw new Error(`No artwork passed strict ${channel} filter.`);
  }

  private isArtworkAllowedForChannel(channel: ChannelType, artwork: PixivArtwork): boolean {
    if (channel === 'SFW') {
      return !artwork.isNsfw;
    }
    return artwork.isNsfw;
  }

  private assertArtworkAllowedForChannel(channel: ChannelType, artwork: PixivArtwork): void {
    if (!this.isArtworkAllowedForChannel(channel, artwork)) {
      if (channel === 'SFW') {
        throw new Error('Этот Pixiv пост отмечен как 18+ и заблокирован для SFW канала.');
      }
      throw new Error('Этот Pixiv пост не 18+, он заблокирован для NSFW канала.');
    }
  }

  private async buildUgoiraAssets(
    artworkId: number,
    zipUrl: string,
    frames: Array<{ file: string; delay: number }>
  ): Promise<{ gifPath: string; framesArchivePath: string }> {
    const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path || 'ffmpeg';
    const workDir = path.join('/tmp', `ugoira-${artworkId}-${Date.now()}-${randomUUID()}`);
    fs.mkdirSync(workDir, { recursive: true });

    const zipPath = await this.pixivService.downloadUrl(zipUrl, '.zip');
    const gifPath = path.join('/tmp', `ugoira-${artworkId}-${Date.now()}-${randomUUID()}.gif`);
    const framesArchivePath = path.join('/tmp', `ugoira-${artworkId}-${Date.now()}-${randomUUID()}.tar.gz`);

    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(workDir, true);

      const listPath = path.join(workDir, 'frames.ffconcat');
      const lines = ['ffconcat version 1.0'];

      for (const frame of frames) {
        const framePath = path.join(workDir, frame.file);
        if (!fs.existsSync(framePath)) continue;
        const sec = Math.max(0.01, Number(frame.delay || 100) / 1000);
        lines.push(`file ${framePath}`);
        lines.push(`duration ${sec.toFixed(3)}`);
      }

      const validFiles = lines.filter((x) => x.startsWith('file '));
      if (!validFiles.length) {
        throw new Error(`Ugoira ${artworkId} has no extractable frames.`);
      }

      lines.push(validFiles[validFiles.length - 1].replace(/^file\s+/, 'file '));
      fs.writeFileSync(listPath, `${lines.join('\n')}\n`);

      await this.execFileAsync(ffmpegPath, [
        '-v', 'error',
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-vf', 'fps=24,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        '-loop', '0',
        gifPath
      ]);

      if (!fs.existsSync(gifPath)) {
        throw new Error(`ffmpeg did not produce GIF for ugoira ${artworkId}.`);
      }

      await this.createTarGzFromDir(workDir, framesArchivePath);
      return { gifPath, framesArchivePath };
    } catch (error: any) {
      const message = String(error?.message || error);
      throw new Error(`Ugoira convert failed. Check ffmpeg availability. ${message}`);
    } finally {
      this.safeRemoveFile(zipPath);
      this.safeRemoveDir(workDir);
    }
  }

  private async createTarGzFromDir(sourceDir: string, outputPath: string): Promise<void> {
    await this.execFileAsync('tar', ['-czf', outputPath, '-C', sourceDir, '.']);
    if (!fs.existsSync(outputPath)) {
      throw new Error(`tar.gz archive was not created: ${outputPath}`);
    }
  }

  private safeRemoveDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      logError(`Failed to clean temp dir: ${dirPath}`, cleanupError);
    }
  }

  private safeRemoveFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (cleanupError) {
      logError(`Failed to clean temp file: ${filePath}`, cleanupError);
    }
  }
}
