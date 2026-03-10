import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { randomPick } from './utils';

const PixivApi = require('pixiv-api-client');

export interface PixivArtwork {
  id: number;
  title: string;
  artist: string;
  authorId: number;
  tags: string[];
  xRestrict: number;
  sanityLevel: number;
  isNsfw: boolean;
  pageCount: number;
  imageUrl: string;
  previewUrls: string[];
  originalUrls: string[];
  isUgoira: boolean;
  ugoiraZipUrl?: string;
  ugoiraFrames?: Array<{ file: string; delay: number }>;
}

export class PixivService {
  private client: any;
  private initialized = false;
  private tokenExpiresAt = 0;

  constructor(
    private readonly refreshToken: string,
    private readonly accessToken?: string
  ) {
    this.client = new PixivApi();
  }

  async init(): Promise<void> {
    await this.ensureAuth();
  }

  async getRandomArtworkByTags(tags: string[], recentIds: number[]): Promise<PixivArtwork> {
    if (!tags.length) {
      throw new Error('No Pixiv tags configured.');
    }

    await this.init();

    const selectedTag = randomPick(tags);
    const searchResult = await this.client.searchIllust(selectedTag, {
      search_target: 'partial_match_for_tags',
      sort: 'date_desc',
      filter: 'for_ios'
    });

    const illusts = (searchResult?.illusts ?? []) as any[];
    if (!illusts.length) {
      throw new Error(`No artworks found for tag: ${selectedTag}`);
    }

    const nonDuplicate = illusts.filter((illust: any) => !recentIds.includes(Number(illust.id)));
    const chosen: any = randomPick(nonDuplicate.length ? nonDuplicate : illusts);

    const detail = await this.client.illustDetail(chosen.id);
    const illust = detail?.illust || chosen;
    return this.mapIllustToArtwork(illust);
  }

  async getRandomArtworkByAuthors(authorIds: number[], recentIds: number[]): Promise<PixivArtwork> {
    if (!authorIds.length) {
      throw new Error('No Pixiv author IDs configured.');
    }

    await this.init();
    const shuffled = [...authorIds].sort(() => Math.random() - 0.5);
    let lastError: unknown;

    for (const authorId of shuffled) {
      try {
        return await this.getRandomArtworkByAuthor(authorId, recentIds);
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error('No artworks found for configured authors.');
  }

  async getRandomArtworkByAuthor(authorId: number, recentIds: number[]): Promise<PixivArtwork> {
    if (!Number.isFinite(authorId) || authorId <= 0) {
      throw new Error('Invalid Pixiv author ID.');
    }

    await this.init();
    const allIllusts = await this.fetchUserIllustPool(authorId);
    if (!allIllusts.length) {
      throw new Error(`No artworks found for author ${authorId}.`);
    }

    const nonDuplicate = allIllusts.filter((illust: any) => !recentIds.includes(Number(illust.id)));
    const chosen: any = randomPick(nonDuplicate.length ? nonDuplicate : allIllusts);
    const detail = await this.client.illustDetail(chosen.id);
    const illust = detail?.illust || chosen;
    return this.mapIllustToArtwork(illust);
  }

  async getArtworkById(artworkId: number): Promise<PixivArtwork> {
    if (!Number.isFinite(artworkId) || artworkId <= 0) {
      throw new Error('Invalid Pixiv artwork id.');
    }

    await this.init();
    const detail = await this.client.illustDetail(artworkId);
    const illust = detail?.illust;
    if (!illust) {
      throw new Error(`Pixiv artwork ${artworkId} not found.`);
    }
    return this.mapIllustToArtwork(illust);
  }

  async downloadOriginalImage(url: string): Promise<string> {
    return this.downloadUrl(url);
  }

  async downloadUrl(url: string, forcedExt?: string): Promise<string> {
    await this.ensureAuth();

    const tempDir = path.resolve(process.cwd(), 'temp');
    fs.mkdirSync(tempDir, { recursive: true });

    const ext = forcedExt || this.getFileExtension(url);
    const outputPath = path.join(tempDir, `${Date.now()}-${randomUUID()}${ext}`);

    const data = await this.fetchBinaryWithRetry(url);
    fs.writeFileSync(outputPath, data);

    return outputPath;
  }

  private async mapIllustToArtwork(illust: any): Promise<PixivArtwork> {
    const parsedTags = (illust.tags || []).map((tag: any) => tag?.name).filter(Boolean);
    const xRestrict = Number(illust?.x_restrict || 0);
    const sanityLevel = Number(illust?.sanity_level || 0);
    const isNsfw = this.detectNsfw(parsedTags, xRestrict, sanityLevel);
    const previewFallback = illust.image_urls?.large || illust.image_urls?.medium || '';

    if (illust.type === 'ugoira') {
      const meta = await this.client.ugoiraMetaData(illust.id);
      const ugoiraMeta = meta?.ugoira_metadata;
      const zipUrl = ugoiraMeta?.zip_urls?.original || ugoiraMeta?.zip_urls?.medium || ugoiraMeta?.zip_urls?.large;
      const frames = (ugoiraMeta?.frames || [])
        .map((frame: any) => ({ file: String(frame?.file || ''), delay: Number(frame?.delay || 100) }))
        .filter((frame: any) => frame.file);

      if (!zipUrl || !frames.length) {
        throw new Error(`Ugoira ${illust.id} has no zip URL or frames metadata.`);
      }

      return {
        id: Number(illust.id),
        title: illust.title || 'Untitled',
        artist: illust.user?.name || 'Unknown',
        authorId: Number(illust.user?.id || 0),
        tags: parsedTags,
        xRestrict,
        sanityLevel,
        isNsfw,
        pageCount: frames.length,
        imageUrl: previewFallback,
        previewUrls: previewFallback ? [previewFallback] : [],
        originalUrls: [],
        isUgoira: true,
        ugoiraZipUrl: zipUrl,
        ugoiraFrames: frames
      };
    }

    const originalUrls = this.extractOriginalUrls(illust);
    const previewUrls = this.extractPreviewUrls(illust, originalUrls);
    if (!originalUrls.length) {
      throw new Error(`Artwork ${illust.id} has no downloadable image URL.`);
    }

    return {
      id: Number(illust.id),
      title: illust.title || 'Untitled',
      artist: illust.user?.name || 'Unknown',
      authorId: Number(illust.user?.id || 0),
      tags: parsedTags,
      xRestrict,
      sanityLevel,
      isNsfw,
      pageCount: Number(illust.page_count || originalUrls.length || 1),
      imageUrl: previewUrls[0] || originalUrls[0],
      previewUrls,
      originalUrls,
      isUgoira: false
    };
  }

  private detectNsfw(tags: string[], xRestrict: number, sanityLevel: number): boolean {
    const lower = tags.map((tag) => String(tag).toLowerCase());
    if (lower.includes('r-18') || lower.includes('r-18g') || lower.includes('r18') || lower.includes('r18g')) {
      return true;
    }
    return false;
  }

  private extractOriginalUrls(illust: any): string[] {
    if (Array.isArray(illust.meta_pages) && illust.meta_pages.length > 0) {
      return illust.meta_pages
        .map((page: any) => page?.image_urls?.original)
        .filter(Boolean);
    }

    if (illust.meta_single_page?.original_image_url) {
      return [illust.meta_single_page.original_image_url];
    }

    if (illust.image_urls?.large) {
      return [illust.image_urls.large];
    }

    return [];
  }

  private extractPreviewUrls(illust: any, originalUrls: string[]): string[] {
    if (Array.isArray(illust.meta_pages) && illust.meta_pages.length > 0) {
      const urls = illust.meta_pages
        .map((page: any) => page?.image_urls?.large || page?.image_urls?.medium)
        .filter(Boolean);
      return urls.length ? urls : originalUrls;
    }

    if (illust.image_urls?.large) {
      return [illust.image_urls.large];
    }

    if (illust.image_urls?.medium) {
      return [illust.image_urls.medium];
    }

    return originalUrls;
  }

  private getFileExtension(url: string): string {
    try {
      const normalized = url.split('?')[0];
      const ext = path.extname(normalized);
      return ext || '.jpg';
    } catch {
      return '.jpg';
    }
  }

  private async fetchBinary(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: {
        Referer: 'https://www.pixiv.net/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download image: HTTP ${response.status}`);
    }

    const arr = await response.arrayBuffer();
    return Buffer.from(arr);
  }

  private async fetchBinaryWithRetry(url: string, attempts = 4): Promise<Buffer> {
    let lastError: unknown;

    for (let i = 1; i <= attempts; i += 1) {
      try {
        return await this.fetchBinary(url);
      } catch (error) {
        lastError = error;
        if (i < attempts) {
          await this.sleep(400 * i);
        }
      }
    }

    throw lastError;
  }

  private async ensureAuth(): Promise<void> {
    const now = Date.now();
    const shouldRefresh = !this.initialized || now > this.tokenExpiresAt - 60_000;
    if (!shouldRefresh) {
      return;
    }

    if (!this.initialized && this.accessToken) {
      this.client.auth = {
        access_token: this.accessToken,
        refresh_token: this.refreshToken
      };
    }

    const auth = await this.client.refreshAccessToken(this.refreshToken);
    const expiresInSec = Number(auth?.expires_in || auth?.response?.expires_in || 3600);
    this.tokenExpiresAt = now + expiresInSec * 1000;
    this.initialized = true;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchUserIllustPool(userId: number): Promise<any[]> {
    const result: any[] = [];

    const first = await this.client.userIllusts(userId, { type: 'illust' });
    if (Array.isArray(first?.illusts)) {
      result.push(...first.illusts);
    }

    let nextUrl = first?.next_url;
    let pages = 0;

    // Keep pool size bounded for speed and memory.
    while (nextUrl && pages < 3 && result.length < 200) {
      const page = await this.client.requestUrl(nextUrl);
      if (Array.isArray(page?.illusts)) {
        result.push(...page.illusts);
      }
      nextUrl = page?.next_url;
      pages += 1;
    }

    return result;
  }
}
