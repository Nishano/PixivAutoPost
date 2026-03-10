import { Markup, Telegraf } from 'telegraf';
import { AdminRegistry } from './admin-registry';
import { PosterService } from './poster';
import { SchedulerService } from './scheduler';
import {
  ChannelType,
  INTERVAL_LABELS,
  IntervalKey,
  logError,
  readConfig,
  writeConfig
} from './utils';

type PendingUpload =
  | { type: 'photo'; fileId: string; caption?: string }
  | { type: 'document'; fileId: string; caption?: string; mimeType?: string; fileName?: string }
  | { type: 'document_group'; fileIds: string[]; caption?: string }
  | { type: 'photo_group'; fileIds: string[]; caption?: string };

interface PendingPixivPost {
  artworkId: number;
  artist: string;
  pageCount: number;
  isUgoira: boolean;
}

type AuthorAction = 'add' | 'remove';
type AdminAction = 'add' | 'remove';
type PixivCountMode = 'leading' | 'random';

interface AdminState {
  selectedChannel: ChannelType;
  awaitingUploadChannel: boolean;
  awaitingUploadText: boolean;
  awaitingUploadTime: boolean;
  pendingUploadChannel?: ChannelType;
  pendingUploadExtraText?: string;
  pendingUpload?: PendingUpload;
  awaitingPixivCount: boolean;
  pendingPixivPost?: PendingPixivPost;
  pendingPixivChannel?: ChannelType;
  pendingPixivCountMode?: PixivCountMode;
  pendingPixivPageLimit?: number;
  awaitingAuthorInput: boolean;
  pendingAuthorAction?: AuthorAction;
  awaitingAdminInput: boolean;
  pendingAdminAction?: AdminAction;
}

export class AdminService {
  private adminState = new Map<number, AdminState>();
  private mediaGroupBuffer = new Map<string, { adminId: number; fileIds: string[]; caption?: string; timer: NodeJS.Timeout }>();
  private documentGroupBuffer = new Map<string, { adminId: number; fileIds: string[]; caption?: string; timer: NodeJS.Timeout }>();

  constructor(
    private readonly bot: Telegraf,
    private readonly adminRegistry: AdminRegistry,
    private readonly posterService: PosterService,
    private readonly schedulerService: SchedulerService
  ) {}

  registerHandlers(): void {
    this.bot.start(async (ctx) => {
      this.adminRegistry.upsertProfile(ctx.from);
      if (!this.isAdminContext(ctx)) return;
      const state = this.getState(ctx.from.id);
      await ctx.reply('Админ параметры', this.mainMenu(state));
    });

    this.bot.command('menu', async (ctx) => {
      this.adminRegistry.upsertProfile(ctx.from);
      if (!this.isAdminContext(ctx)) return;
      const state = this.getState(ctx.from.id);
      await ctx.reply('Админ параметры', this.mainMenu(state));
    });

    this.bot.on('callback_query', async (ctx) => {
      this.adminRegistry.upsertProfile(ctx.from);
      if (!this.isAdminContext(ctx)) return;

      const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
      if (!data) return;

      await ctx.answerCbQuery().catch(() => undefined);

      try {
        await this.handleCallback(ctx, data);
      } catch (error) {
        logError('Admin callback handler failed', error);
        const errText = error instanceof Error ? error.message : 'Ошибка обработки действия.';
        await this.renderPanel(ctx, `Ошибка: ${errText}`, this.mainMenu(this.getState(ctx.from.id)));
      }
    });

    this.bot.on('message', async (ctx) => {
      this.adminRegistry.upsertProfile(ctx.from);
      if (!this.isAdminContext(ctx)) return;

      try {
        await this.handleAdminMessage(ctx);
      } catch (error) {
        logError('Admin message handler failed', error);
        await ctx.reply('Ошибка обработки сообщения.', this.mainMenu(this.getState(ctx.from.id)));
      }
    });
  }

  private isAdminContext(ctx: any): boolean {
    const userId = Number(ctx.from?.id);
    if (!Number.isFinite(userId) || !this.adminRegistry.isAdmin(userId)) return false;
    return ctx.chat?.type === 'private';
  }

  private getState(adminId: number): AdminState {
    const existing = this.adminState.get(adminId);
    if (existing) return existing;

    const initial: AdminState = {
      selectedChannel: 'SFW',
      awaitingUploadChannel: false,
      awaitingUploadText: false,
      awaitingUploadTime: false,
      awaitingPixivCount: false,
      awaitingAuthorInput: false,
      awaitingAdminInput: false
    };
    this.adminState.set(adminId, initial);
    return initial;
  }

  private mainMenu(state: AdminState) {
    const current = readConfig(state.selectedChannel);
    const autoLabel = current.enabled ? 'Автопост: вкл' : 'Автопост: выкл';

    return Markup.inlineKeyboard([
      [Markup.button.callback('📤 Пост сейчас', `post_now:${state.selectedChannel}`)],
      [Markup.button.callback(`📢 Канал: ${state.selectedChannel}`, 'set_channel_menu')],
      [Markup.button.callback('⏱ Настроить интервал', 'set_interval_menu')],
      [Markup.button.callback('👤 Настройка авторов', 'authors_menu')],
      [Markup.button.callback(`🔄 ${autoLabel}`, 'toggle_autopost_menu')],
      [Markup.button.callback('🛡 Управление админами', 'admins_menu')],
      [Markup.button.callback('⚙️ Настройки', 'settings')]
    ]);
  }

  private intervalMenu() {
    return this.withBackAndMainMenu([
      [
        Markup.button.callback('5 минут', 'interval:5m'),
        Markup.button.callback('10 минут', 'interval:10m')
      ],
      [
        Markup.button.callback('30 минут', 'interval:30m'),
        Markup.button.callback('1 час', 'interval:1h')
      ],
      [
        Markup.button.callback('3 часа', 'interval:3h'),
        Markup.button.callback('4 часа', 'interval:4h')
      ],
      [
        Markup.button.callback('6 часов', 'interval:6h'),
        Markup.button.callback('1 день', 'interval:24h')
      ]
    ], 'back_to_menu');
  }

  private authorsMenu() {
    return this.withBackAndMainMenu(this.toTwoColumnRows([
      Markup.button.callback('➕ Добавить авторов', 'authors_add_menu'),
      Markup.button.callback('➖ Удалить авторов', 'authors_remove_menu'),
      Markup.button.callback('📋 Общий список авторов', 'authors_list_all')
    ]), 'back_to_menu');
  }

  private adminsMenu() {
    return this.withBackAndMainMenu(this.toTwoColumnRows([
      Markup.button.callback('➕ Добавить админов', 'admins_add_menu'),
      Markup.button.callback('➖ Удалить админов', 'admins_remove_menu'),
      Markup.button.callback('📋 Список админов', 'admins_list')
    ]), 'back_to_menu');
  }

  private channelMenu(prefix = 'channel', backData = 'back_to_menu') {
    return this.withBackAndMainMenu([
      [
        Markup.button.callback('SFW', `${prefix}:SFW`),
        Markup.button.callback('NSFW', `${prefix}:NSFW`)
      ]
    ], backData);
  }

  private uploadChannelMenu() {
    return this.withBackAndMainMenu([
      [
        Markup.button.callback('SFW', 'upload_channel:SFW'),
        Markup.button.callback('NSFW', 'upload_channel:NSFW')
      ],
      [Markup.button.callback('❌ Отмена', 'upload_cancel')]
    ], 'upload_cancel');
  }

  private uploadActionsMenu() {
    return this.withBackAndMainMenu(this.toTwoColumnRows([
      Markup.button.callback('📤 Запостить', 'upload_post_now'),
      Markup.button.callback('⏰ Запланировать', 'upload_schedule'),
      Markup.button.callback('📝 Текст к посту', 'upload_set_text'),
      Markup.button.callback('❌ Отмена', 'upload_cancel')
    ]), 'upload_back_to_channel');
  }

  private pixivConfirmMenu(backData = 'pixiv_back_to_channel') {
    return this.withBackAndMainMenu([
      [
        Markup.button.callback('✅ Постить', 'pixiv_confirm_yes'),
        Markup.button.callback('❌ Отмена', 'pixiv_confirm_no')
      ]
    ], backData);
  }

  private pixivCountMenu(pageCount: number) {
    const buttons: any[] = [];

    if (pageCount > 10) {
      buttons.push(Markup.button.callback('🔟 Первые 10', 'pixiv_count_ten'));
      buttons.push(Markup.button.callback('🎲 Рандомные 10', 'pixiv_count_random_ten'));
    }

    buttons.push(Markup.button.callback('📚 Все страницы', 'pixiv_count_all'));
    buttons.push(Markup.button.callback('🔢 Указать количество', 'pixiv_count_manual'));
    buttons.push(Markup.button.callback('🎲 Рандомные N', 'pixiv_count_random_manual'));
    buttons.push(Markup.button.callback('❌ Отмена', 'pixiv_confirm_no'));

    return this.withBackAndMainMenu(this.toTwoColumnRows(buttons), 'pixiv_back_to_channel');
  }

  private withBackAndMainMenu(rows: any[][], backData: string) {
    return Markup.inlineKeyboard([
      ...rows,
      [
        Markup.button.callback('⬅️ Назад', backData),
        Markup.button.callback('🏠 Главное меню', 'go_main_menu')
      ]
    ]);
  }

  private toTwoColumnRows(buttons: any[]): any[][] {
    const rows: any[][] = [];

    for (let index = 0; index < buttons.length; index += 2) {
      rows.push(buttons.slice(index, index + 2));
    }

    return rows;
  }

  private promptNav(backData: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('⬅️ Назад', backData),
        Markup.button.callback('🏠 Главное меню', 'go_main_menu')
      ]
    ]);
  }

  private async handleCallback(ctx: any, data: string): Promise<void> {
    const state = this.getState(ctx.from.id);

    if (data === 'back_to_menu') {
      this.resetTransientState(state);
      await this.renderPanel(ctx, 'Админ параметры', this.mainMenu(state));
      return;
    }

    if (data === 'go_main_menu') {
      this.resetTransientState(state);
      await this.renderPanel(ctx, 'Админ параметры', this.mainMenu(state));
      return;
    }

    if (data.startsWith('post_now:')) {
      const channel = data.replace('post_now:', '') as ChannelType;
      state.selectedChannel = channel;
      await this.renderPanel(ctx, `Постинг в ${channel}...`, this.promptNav('back_to_menu'));
      await this.posterService.postRandomArtwork(channel);
      await this.renderPanel(ctx, 'Пост отправлен.', this.mainMenu(state));
      return;
    }

    if (data === 'set_channel_menu') {
      await this.renderPanel(ctx, 'Выберите рабочий канал:', this.channelMenu('set_channel'));
      return;
    }

    if (data.startsWith('set_channel:')) {
      const channel = data.replace('set_channel:', '') as ChannelType;
      state.selectedChannel = channel;
      await this.renderPanel(ctx, `Рабочий канал: ${channel}`, this.mainMenu(state));
      return;
    }

    if (data === 'upload_cancel') {
      this.resetUploadState(state);
      await this.renderPanel(ctx, 'Загрузка отменена.', this.mainMenu(state));
      return;
    }

    if (data === 'upload_back_to_channel') {
      if (!state.pendingUpload) {
        this.resetUploadState(state);
        await this.renderPanel(ctx, 'Сначала отправьте файл или альбом.', this.mainMenu(state));
        return;
      }

      state.pendingUploadChannel = undefined;
      state.awaitingUploadChannel = true;
      state.awaitingUploadText = false;
      state.awaitingUploadTime = false;
      await this.renderPanel(ctx, 'Выберите канал для отправки файла.', this.uploadChannelMenu());
      return;
    }

    if (data === 'upload_back_to_actions') {
      if (!state.pendingUpload || !state.pendingUploadChannel) {
        this.resetUploadState(state);
        await this.renderPanel(ctx, 'Сначала отправьте файл и выберите канал.', this.mainMenu(state));
        return;
      }

      state.awaitingUploadText = false;
      state.awaitingUploadTime = false;
      await this.renderPanel(ctx, this.uploadActionsText(state), this.uploadActionsMenu());
      return;
    }

    if (data.startsWith('upload_channel:')) {
      if (!state.pendingUpload) {
        this.resetUploadState(state);
        await this.renderPanel(ctx, 'Сначала отправьте файл или альбом.', this.mainMenu(state));
        return;
      }

      const channel = data.replace('upload_channel:', '') as ChannelType;
      state.pendingUploadChannel = channel;
      state.awaitingUploadChannel = false;
      state.awaitingUploadText = false;
      state.awaitingUploadTime = false;

      await this.renderPanel(ctx, this.uploadActionsText(state), this.uploadActionsMenu());
      return;
    }

    if (data === 'upload_set_text') {
      if (!state.pendingUpload || !state.pendingUploadChannel) {
        this.resetUploadState(state);
        await this.renderPanel(ctx, 'Сначала отправьте файл и выберите канал.', this.mainMenu(state));
        return;
      }

      state.awaitingUploadText = true;
      state.awaitingUploadTime = false;
      await this.renderPanel(
        ctx,
        'Отправьте текст к посту. Если он не нужен, нажмите «Назад».',
        this.promptNav('upload_back_to_actions')
      );
      return;
    }

    if (data === 'upload_schedule') {
      if (!state.pendingUpload || !state.pendingUploadChannel) {
        this.resetUploadState(state);
        await this.renderPanel(ctx, 'Сначала отправьте файл и выберите канал.', this.mainMenu(state));
        return;
      }

      state.awaitingUploadTime = true;
      state.awaitingUploadText = false;
      await this.renderPanel(
        ctx,
        'Введите время отправки в формате HH:mm (24ч). Если время уже прошло, отправка будет завтра.',
        this.promptNav('upload_back_to_actions')
      );
      return;
    }

    if (data === 'upload_post_now') {
      if (!state.pendingUpload || !state.pendingUploadChannel) {
        this.resetUploadState(state);
        await this.renderPanel(ctx, 'Сначала отправьте файл и выберите канал.', this.mainMenu(state));
        return;
      }

      const upload = state.pendingUpload;
      const channel = state.pendingUploadChannel;
      const extraText = state.pendingUploadExtraText;
      this.resetUploadState(state);

      await this.renderPanel(ctx, `Отправка в ${channel}...`, this.promptNav('back_to_menu'));
      await this.posterService.postAdminUpload(channel, upload, this.getSenderName(ctx.from), extraText);
      await this.renderPanel(ctx, `Файл отправлен в ${channel}.`, this.mainMenu(state));
      return;
    }

    if (data === 'set_interval_menu') {
      await this.renderPanel(ctx, `Канал: ${state.selectedChannel}. Выберите интервал:`, this.intervalMenu());
      return;
    }

    if (data === 'pixiv_confirm_no') {
      state.pendingPixivPost = undefined;
      state.pendingPixivChannel = undefined;
      state.pendingPixivCountMode = undefined;
      state.pendingPixivPageLimit = undefined;
      state.awaitingPixivCount = false;
      await this.renderPanel(ctx, 'Пост по ссылке отменён.', this.mainMenu(state));
      return;
    }

    if (data.startsWith('pixiv_channel:')) {
      const pending = state.pendingPixivPost;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }

      state.pendingPixivChannel = data.replace('pixiv_channel:', '') as ChannelType;
      state.pendingPixivCountMode = undefined;
      state.pendingPixivPageLimit = undefined;
      state.awaitingPixivCount = false;

      if (pending.isUgoira || pending.pageCount <= 1) {
        state.pendingPixivCountMode = 'leading';
        state.pendingPixivPageLimit = 1;
        await this.renderPanel(ctx, this.pixivConfirmText(state), this.pixivConfirmMenu('pixiv_back_to_channel'));
        return;
      }

      await this.renderPanel(ctx, this.pixivCountText(pending.pageCount), this.pixivCountMenu(pending.pageCount));
      return;
    }

    if (data === 'pixiv_back_to_channel') {
      const pending = state.pendingPixivPost;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }

      state.pendingPixivChannel = undefined;
      state.pendingPixivCountMode = undefined;
      state.pendingPixivPageLimit = undefined;
      state.awaitingPixivCount = false;
      await this.renderPanel(
        ctx,
        this.pixivChannelText(pending),
        this.channelMenu('pixiv_channel', 'back_to_menu')
      );
      return;
    }

    if (data === 'pixiv_back_to_confirm') {
      const pending = state.pendingPixivPost;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }

      state.pendingPixivCountMode = undefined;
      state.pendingPixivPageLimit = undefined;
      state.awaitingPixivCount = false;
      await this.renderPanel(ctx, this.pixivCountText(pending.pageCount), this.pixivCountMenu(pending.pageCount));
      return;
    }

    if (data === 'pixiv_back_to_count_menu') {
      const pending = state.pendingPixivPost;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }

      state.awaitingPixivCount = false;
      state.pendingPixivCountMode = undefined;
      state.pendingPixivPageLimit = undefined;
      await this.renderPanel(ctx, this.pixivCountText(pending.pageCount), this.pixivCountMenu(pending.pageCount));
      return;
    }

    if (data === 'pixiv_confirm_yes') {
      const pending = state.pendingPixivPost;
      const channel = state.pendingPixivChannel;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }
      if (!channel) {
        await this.renderPanel(
          ctx,
          this.pixivChannelText(pending),
          this.channelMenu('pixiv_channel', 'back_to_menu')
        );
        return;
      }

      const countMode = state.pendingPixivCountMode || 'leading';
      const pageLimit = state.pendingPixivPageLimit || (pending.isUgoira || pending.pageCount <= 1 ? 1 : 0);

      if (!pageLimit) {
        state.awaitingPixivCount = false;
        await this.renderPanel(ctx, this.pixivCountText(pending.pageCount), this.pixivCountMenu(pending.pageCount));
        return;
      }

      await this.renderPanel(
        ctx,
        countMode === 'random'
          ? `Постинг Pixiv #${pending.artworkId} (${pageLimit} случайных стр.) в ${channel}...`
          : `Постинг Pixiv #${pending.artworkId} (${pageLimit} стр.) в ${channel}...`,
        this.promptNav('back_to_menu')
      );
      await this.posterService.postPixivArtworkById(channel, pending.artworkId, pageLimit, false, countMode);
      state.pendingPixivPost = undefined;
      state.pendingPixivChannel = undefined;
      state.pendingPixivCountMode = undefined;
      state.pendingPixivPageLimit = undefined;
      state.awaitingPixivCount = false;
      await this.renderPanel(ctx, this.pixivPostedText(pageLimit, countMode === 'random'), this.mainMenu(state));
      return;
    }

    if (data === 'pixiv_count_ten') {
      const pending = state.pendingPixivPost;
      const channel = state.pendingPixivChannel;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }
      if (!channel) {
        await this.renderPanel(
          ctx,
          this.pixivChannelText(pending),
          this.channelMenu('pixiv_channel', 'back_to_menu')
        );
        return;
      }

      const count = Math.min(10, pending.pageCount);
      state.pendingPixivCountMode = 'leading';
      state.pendingPixivPageLimit = count;
      state.awaitingPixivCount = false;
      await this.renderPanel(ctx, this.pixivConfirmText(state), this.pixivConfirmMenu('pixiv_back_to_confirm'));
      return;
    }

    if (data === 'pixiv_count_random_ten') {
      const pending = state.pendingPixivPost;
      const channel = state.pendingPixivChannel;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }
      if (!channel) {
        await this.renderPanel(
          ctx,
          this.pixivChannelText(pending),
          this.channelMenu('pixiv_channel', 'back_to_menu')
        );
        return;
      }

      const count = Math.min(10, pending.pageCount);
      state.pendingPixivCountMode = 'random';
      state.pendingPixivPageLimit = count;
      state.awaitingPixivCount = false;
      await this.renderPanel(ctx, this.pixivConfirmText(state), this.pixivConfirmMenu('pixiv_back_to_confirm'));
      return;
    }

    if (data === 'pixiv_count_all') {
      const pending = state.pendingPixivPost;
      const channel = state.pendingPixivChannel;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }
      if (!channel) {
        await this.renderPanel(
          ctx,
          this.pixivChannelText(pending),
          this.channelMenu('pixiv_channel', 'back_to_menu')
        );
        return;
      }

      state.pendingPixivCountMode = 'leading';
      state.pendingPixivPageLimit = pending.pageCount;
      state.awaitingPixivCount = false;
      await this.renderPanel(ctx, this.pixivConfirmText(state), this.pixivConfirmMenu('pixiv_back_to_confirm'));
      return;
    }

    if (data === 'pixiv_count_manual') {
      const pending = state.pendingPixivPost;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }
      state.pendingPixivCountMode = 'leading';
      state.pendingPixivPageLimit = undefined;
      state.awaitingPixivCount = true;
      await this.renderPanel(
        ctx,
        `Введите число от 1 до ${pending.pageCount}, сколько страниц запостить.`,
        this.promptNav('pixiv_back_to_count_menu')
      );
      return;
    }

    if (data === 'pixiv_count_random_manual') {
      const pending = state.pendingPixivPost;
      if (!pending) {
        await this.renderPanel(ctx, 'Сначала отправьте ссылку Pixiv.', this.mainMenu(state));
        return;
      }
      state.pendingPixivCountMode = 'random';
      state.pendingPixivPageLimit = undefined;
      state.awaitingPixivCount = true;
      await this.renderPanel(
        ctx,
        `Введите число от 1 до ${pending.pageCount}, сколько случайных страниц запостить.`,
        this.promptNav('pixiv_back_to_count_menu')
      );
      return;
    }

    if (data.startsWith('interval:')) {
      const interval = data.replace('interval:', '') as IntervalKey;
      const config = readConfig(state.selectedChannel);
      config.interval = interval;
      writeConfig(state.selectedChannel, config);
      this.schedulerService.restartForChannel(state.selectedChannel);
      await this.renderPanel(
        ctx,
        `Интервал для ${state.selectedChannel}: ${INTERVAL_LABELS[interval]}`,
        this.mainMenu(state)
      );
      return;
    }

    if (data === 'authors_menu') {
      await this.renderPanel(ctx, 'Настройка авторов', this.authorsMenu());
      return;
    }

    if (data === 'authors_add_menu' || data === 'authors_remove_menu') {
      state.pendingAuthorAction = data === 'authors_add_menu' ? 'add' : 'remove';
      state.awaitingAuthorInput = true;

      const config = readConfig(state.selectedChannel);
      const current = config.authorIds.join(', ') || 'пусто';
      await this.renderPanel(
        ctx,
        `Канал: ${state.selectedChannel}\nТекущие авторы: ${current}\nОтправьте ID автора или несколько через запятую.`,
        this.promptNav('authors_back')
      );
      return;
    }

    if (data === 'authors_back') {
      state.awaitingAuthorInput = false;
      state.pendingAuthorAction = undefined;
      await this.renderPanel(ctx, 'Настройка авторов', this.authorsMenu());
      return;
    }

    if (data === 'authors_list_all') {
      const sfw = readConfig('SFW');
      const nsfw = readConfig('NSFW');
      const text = [
        '📋 Авторы по каналам',
        '',
        `SFW: ${sfw.authorIds.join(', ') || 'пусто'}`,
        `NSFW: ${nsfw.authorIds.join(', ') || 'пусто'}`
      ].join('\n');
      await this.renderPanel(ctx, text, this.authorsMenu());
      return;
    }

    if (data === 'toggle_autopost_menu') {
      const config = readConfig(state.selectedChannel);
      config.enabled = !config.enabled;
      writeConfig(state.selectedChannel, config);
      this.schedulerService.restartForChannel(state.selectedChannel);
      await this.renderPanel(
        ctx,
        `${state.selectedChannel}: автопост ${config.enabled ? 'включён' : 'выключен'}.`,
        this.mainMenu(state)
      );
      return;
    }

    if (data === 'admins_menu') {
      await this.renderPanel(ctx, 'Управление админами', this.adminsMenu());
      return;
    }

    if (data === 'admins_add_menu' || data === 'admins_remove_menu') {
      state.pendingAdminAction = data === 'admins_add_menu' ? 'add' : 'remove';
      state.awaitingAdminInput = true;
      await this.renderPanel(
        ctx,
        'Отправьте ID админа или несколько ID через запятую.',
        this.promptNav('admins_back')
      );
      return;
    }

    if (data === 'admins_back') {
      state.awaitingAdminInput = false;
      state.pendingAdminAction = undefined;
      await this.renderPanel(ctx, 'Управление админами', this.adminsMenu());
      return;
    }

    if (data === 'admins_list') {
      const rows = this.adminRegistry.listAdmins().map((a) => `${a.tag} ${a.nick}${a.protected ? ' [защищён]' : ''}`);
      const text = ['📋 Список админов', '', ...rows].join('\n');
      await this.renderPanel(ctx, text, this.adminsMenu());
      return;
    }

    if (data === 'settings') {
      const sfw = readConfig('SFW');
      const nsfw = readConfig('NSFW');
      const text = [
        '⚙️ Настройки',
        '',
        `Текущий канал: ${state.selectedChannel}`,
        '',
        `SFW`,
        `Канал: ${sfw.channelId}`,
        `Автопост: ${sfw.enabled ? 'включён' : 'выключен'}`,
        `Интервал: ${INTERVAL_LABELS[sfw.interval]}`,
        `Авторы: ${sfw.authorIds.join(', ') || 'пусто'}`,
        '',
        `NSFW`,
        `Канал: ${nsfw.channelId}`,
        `Автопост: ${nsfw.enabled ? 'включён' : 'выключен'}`,
        `Интервал: ${INTERVAL_LABELS[nsfw.interval]}`,
        `Авторы: ${nsfw.authorIds.join(', ') || 'пусто'}`
      ].join('\n');

      await this.renderPanel(ctx, text, this.mainMenu(state));
      return;
    }
  }

  private async handleAdminMessage(ctx: any): Promise<void> {
    const state = this.getState(ctx.from.id);
    const message = ctx.message;

    if (state.awaitingAdminInput && state.pendingAdminAction && message?.text) {
      const ids = this.parseIds(message.text);
      if (!ids.length) {
        await ctx.reply('Не удалось распознать ID. Пример: 12345, 67890', this.promptNav('admins_back'));
        return;
      }

      if (state.pendingAdminAction === 'add') {
        const added = this.adminRegistry.addAdmins(ids);
        await ctx.reply(`Добавлены админы: ${added.join(', ') || 'нет новых'}`, this.adminsMenu());
      } else {
        const result = this.adminRegistry.removeAdmins(ids);
        await ctx.reply(
          `Удалены: ${result.removed.join(', ') || 'никого'}\n` +
          `Нельзя удалить: ${result.blocked.join(', ') || 'нет'}`,
          this.adminsMenu()
        );
      }

      state.awaitingAdminInput = false;
      state.pendingAdminAction = undefined;
      return;
    }

    if (state.awaitingPixivCount && state.pendingPixivPost && message?.text) {
      const value = Number(message.text.trim());
      const max = state.pendingPixivPost.pageCount;
      if (!Number.isInteger(value) || value < 1 || value > max) {
        await ctx.reply(`Нужно число от 1 до ${max}.`, this.promptNav('pixiv_back_to_count_menu'));
        return;
      }

      const artworkId = state.pendingPixivPost.artworkId;
      const channel = state.pendingPixivChannel;
      const countMode = state.pendingPixivCountMode || 'leading';
      if (!channel) {
        await ctx.reply(
          this.pixivChannelText(state.pendingPixivPost),
          this.channelMenu('pixiv_channel', 'back_to_menu')
        );
        return;
      }
      state.pendingPixivPageLimit = value;
      state.awaitingPixivCount = false;
      await ctx.reply(this.pixivConfirmText(state), this.pixivConfirmMenu('pixiv_back_to_confirm'));
      return;
    }

    if (state.awaitingAuthorInput && state.pendingAuthorAction && message?.text) {
      const ids = this.parseIds(message.text);
      if (!ids.length) {
        await ctx.reply('Не удалось распознать ID. Пример: 12345, 67890', this.promptNav('authors_back'));
        return;
      }

      const config = readConfig(state.selectedChannel);
      if (state.pendingAuthorAction === 'add') {
        config.authorIds = Array.from(new Set([...config.authorIds, ...ids]));
      } else {
        config.authorIds = config.authorIds.filter((id) => !ids.includes(id));
      }
      writeConfig(state.selectedChannel, config);

      state.awaitingAuthorInput = false;
      state.pendingAuthorAction = undefined;

      await ctx.reply(`Готово. ${state.selectedChannel} авторы: ${config.authorIds.join(', ') || 'пусто'}`, this.authorsMenu());
      return;
    }

    if (state.awaitingUploadChannel && state.pendingUpload && message?.text) {
      await ctx.reply('Выберите канал для этой загрузки.', this.uploadChannelMenu());
      return;
    }

    if (state.awaitingUploadText && state.pendingUpload && state.pendingUploadChannel && message?.text) {
      const text = message.text.trim();
      state.pendingUploadExtraText = text;
      state.awaitingUploadText = false;
      state.awaitingUploadTime = false;

      await ctx.reply(this.uploadActionsText(state), this.uploadActionsMenu());
      return;
    }

    if (state.awaitingUploadTime && state.pendingUpload && state.pendingUploadChannel && message?.text) {
      const timeInput = message.text.trim();
      const senderName = this.getSenderName(ctx.from);
      const delayMs = this.parseUploadDelayMs(timeInput);
      if (delayMs === null) {
        await ctx.reply(
          'Неверный формат. Используйте HH:mm, например 14:45.',
          this.promptNav('upload_back_to_actions')
        );
        return;
      }

      const upload = state.pendingUpload;
      const channel = state.pendingUploadChannel;
      const extraText = state.pendingUploadExtraText;

      this.resetUploadState(state);

      setTimeout(async () => {
        try {
          await this.posterService.postAdminUpload(channel, upload, senderName, extraText);
        } catch (error) {
          logError(`Delayed manual upload failed for ${channel}`, error);
        }
      }, delayMs);
      await ctx.reply(`Запланировано на ${timeInput} (${channel}).`, this.mainMenu(state));
      return;
    }

    if (message?.photo?.length) {
      const largestPhoto = message.photo[message.photo.length - 1];
      const mediaGroupId = message.media_group_id;

      if (mediaGroupId) {
        this.collectPhotoGroup(mediaGroupId, ctx.from.id, largestPhoto.file_id, message.caption);
        return;
      }

      this.startUploadFlow(
        state,
        { type: 'photo', fileId: largestPhoto.file_id, caption: message.caption }
      );
      await ctx.reply('Выберите канал для отправки файла.', this.uploadChannelMenu());
      return;
    }

    if (message?.document) {
      const mediaGroupId = message.media_group_id;
      if (mediaGroupId) {
        this.collectDocumentGroup(mediaGroupId, ctx.from.id, message.document.file_id, message.caption);
        return;
      }

      this.startUploadFlow(state, {
        type: 'document',
        fileId: message.document.file_id,
        caption: message.caption,
        mimeType: message.document.mime_type,
        fileName: message.document.file_name
      });

      await ctx.reply('Выберите канал для отправки файла.', this.uploadChannelMenu());
      return;
    }

    if (message?.text) {
      const artworkId = this.extractPixivArtworkId(message.text);
      if (!artworkId) {
        return;
      }

      try {
        const info = await this.posterService.inspectPixivArtwork(artworkId);
        state.pendingPixivPost = {
          artworkId: info.id,
          artist: info.artist,
          pageCount: info.pageCount,
          isUgoira: info.isUgoira
        };
        state.pendingPixivChannel = undefined;
        state.pendingPixivCountMode = undefined;
        state.pendingPixivPageLimit = undefined;
        state.awaitingPixivCount = false;

        await ctx.reply(
          this.pixivChannelText(state.pendingPixivPost),
          this.channelMenu('pixiv_channel', 'back_to_menu')
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : 'Не удалось получить пост.';
        await ctx.reply(`Ссылку обработать не удалось: ${text}`, this.promptNav('back_to_menu'));
      }
    }
  }

  private collectPhotoGroup(mediaGroupId: string, adminId: number, fileId: string, caption?: string): void {
    const existing = this.mediaGroupBuffer.get(mediaGroupId);
    if (existing) {
      existing.fileIds.push(fileId);
      if (caption) existing.caption = caption;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        void this.finalizePhotoGroup(mediaGroupId);
      }, 1200);
      return;
    }

    const timer = setTimeout(() => {
      void this.finalizePhotoGroup(mediaGroupId);
    }, 1200);

    this.mediaGroupBuffer.set(mediaGroupId, {
      adminId,
      fileIds: [fileId],
      caption,
      timer
    });
  }

  private async finalizePhotoGroup(mediaGroupId: string): Promise<void> {
    const item = this.mediaGroupBuffer.get(mediaGroupId);
    if (!item) return;
    this.mediaGroupBuffer.delete(mediaGroupId);

    const state = this.getState(item.adminId);
    const uniqueFileIds = Array.from(new Set(item.fileIds));
    this.startUploadFlow(state, { type: 'photo_group', fileIds: uniqueFileIds, caption: item.caption });

    await this.bot.telegram.sendMessage(
      String(item.adminId),
      `Альбом (${uniqueFileIds.length} фото). Выберите канал для отправки.`,
      this.uploadChannelMenu()
    );
  }

  private collectDocumentGroup(mediaGroupId: string, adminId: number, fileId: string, caption?: string): void {
    const existing = this.documentGroupBuffer.get(mediaGroupId);
    if (existing) {
      existing.fileIds.push(fileId);
      if (caption) existing.caption = caption;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        void this.finalizeDocumentGroup(mediaGroupId);
      }, 1200);
      return;
    }

    const timer = setTimeout(() => {
      void this.finalizeDocumentGroup(mediaGroupId);
    }, 1200);

    this.documentGroupBuffer.set(mediaGroupId, {
      adminId,
      fileIds: [fileId],
      caption,
      timer
    });
  }

  private async finalizeDocumentGroup(mediaGroupId: string): Promise<void> {
    const item = this.documentGroupBuffer.get(mediaGroupId);
    if (!item) return;
    this.documentGroupBuffer.delete(mediaGroupId);

    const state = this.getState(item.adminId);
    const uniqueFileIds = Array.from(new Set(item.fileIds));
    this.startUploadFlow(state, { type: 'document_group', fileIds: uniqueFileIds, caption: item.caption });

    await this.bot.telegram.sendMessage(
      String(item.adminId),
      `Группа документов (${uniqueFileIds.length} шт). Выберите канал для отправки.`,
      this.uploadChannelMenu()
    );
  }

  private startUploadFlow(state: AdminState, upload: PendingUpload): void {
    state.pendingUpload = upload;
    state.pendingUploadChannel = undefined;
    state.pendingUploadExtraText = undefined;
    state.awaitingUploadChannel = true;
    state.awaitingUploadText = false;
    state.awaitingUploadTime = false;
  }

  private resetUploadState(state: AdminState): void {
    state.awaitingUploadChannel = false;
    state.awaitingUploadText = false;
    state.awaitingUploadTime = false;
    state.pendingUpload = undefined;
    state.pendingUploadChannel = undefined;
    state.pendingUploadExtraText = undefined;
  }

  private resetTransientState(state: AdminState): void {
    this.resetUploadState(state);
    state.awaitingPixivCount = false;
    state.pendingPixivPost = undefined;
    state.pendingPixivChannel = undefined;
    state.pendingPixivCountMode = undefined;
    state.pendingPixivPageLimit = undefined;
    state.awaitingAuthorInput = false;
    state.pendingAuthorAction = undefined;
    state.awaitingAdminInput = false;
    state.pendingAdminAction = undefined;
  }

  private uploadActionsText(state: AdminState): string {
    const upload = state.pendingUpload;
    const channel = state.pendingUploadChannel;
    const lines = [
      this.describePendingUpload(upload),
      `Канал: ${channel || 'не выбран'}`,
      `Текст к посту: ${state.pendingUploadExtraText?.trim() ? 'добавлен' : 'нет'}`,
      '',
      'Выберите действие:'
    ];

    return lines.join('\n');
  }

  private pixivConfirmText(state: AdminState): string {
    const info = state.pendingPixivPost;
    if (!info) {
      return 'Сначала отправьте ссылку Pixiv.';
    }

    return [
      `Найден Pixiv пост #${info.artworkId}`,
      `Автор: ${info.artist}`,
      `Тип: ${info.isUgoira ? 'GIF (ugoira)' : 'Изображения'}`,
      `Страниц: ${info.pageCount}`,
      `Канал: ${state.pendingPixivChannel || 'не выбран'}`,
      this.pixivSelectionText(state),
      '',
      'Постить?'
    ].filter(Boolean).join('\n');
  }

  private pixivChannelText(info: PendingPixivPost): string {
    return [
      `Найден Pixiv пост #${info.artworkId}`,
      `Автор: ${info.artist}`,
      `Тип: ${info.isUgoira ? 'GIF (ugoira)' : 'Изображения'}`,
      `Страниц: ${info.pageCount}`,
      '',
      'Выберите канал для отправки.'
    ].join('\n');
  }

  private pixivCountText(pageCount: number): string {
    const lines = [`В посте ${pageCount} страниц.`];

    if (pageCount > 10) {
      lines.push('Если выберете больше 10, бот разобьёт превью и оригиналы на несколько постов по 10 страниц.');
    }

    lines.push('Сколько страниц отправить?');
    return lines.join('\n');
  }

  private pixivPostedText(pageCount: number, randomSelection = false): string {
    if (randomSelection) {
      if (pageCount > 10) {
        return 'Посты отправлены. Опубликованы случайные страницы из работы, разбитые на несколько постов по 10.';
      }

      return 'Пост отправлен. Опубликованы случайные страницы из работы.';
    }

    if (pageCount > 10) {
      return 'Посты отправлены. Превью и оригиналы разбиты на несколько постов по 10 страниц.';
    }

    return 'Пост отправлен.';
  }

  private pixivSelectionText(state: AdminState): string {
    const pending = state.pendingPixivPost;
    const pageLimit = state.pendingPixivPageLimit;
    if (!pending || !pageLimit) {
      return '';
    }

    if (pending.isUgoira || pending.pageCount <= 1) {
      return 'Страниц к отправке: 1';
    }

    if (state.pendingPixivCountMode === 'random') {
      return `Случайных страниц: ${pageLimit}`;
    }

    if (pageLimit >= pending.pageCount) {
      return `Страниц к отправке: все (${pending.pageCount})`;
    }

    return `Страниц к отправке: ${pageLimit}`;
  }

  private describePendingUpload(upload?: PendingUpload): string {
    if (!upload) return 'Файл не выбран.';

    if (upload.type === 'photo') return 'Подготовлено фото.';
    if (upload.type === 'document') return 'Подготовлен документ.';
    if (upload.type === 'photo_group') return `Подготовлен альбом (${upload.fileIds.length} фото).`;
    return `Подготовлена группа документов (${upload.fileIds.length} шт).`;
  }

  private parseIds(raw: string): number[] {
    return raw
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && x > 0);
  }

  private parseUploadDelayMs(raw: string): number | null {
    const m = raw.match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;

    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

    const now = new Date();
    const target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  private extractPixivArtworkId(raw: string): number | null {
    const match = raw.match(/pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i);
    if (!match) return null;
    const artworkId = Number(match[1]);
    if (!Number.isFinite(artworkId) || artworkId <= 0) return null;
    return artworkId;
  }

  private getSenderName(user: any): string {
    if (!user) return 'Unknown';

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    if (fullName) return fullName;
    if (user.username) return `@${user.username}`;
    return String(user.id || 'Unknown');
  }

  private async renderPanel(ctx: any, text: string, markup?: any): Promise<void> {
    const resolvedMarkup = markup ?? this.promptNav('back_to_menu');

    try {
      await ctx.editMessageText(text, { reply_markup: resolvedMarkup.reply_markup });
    } catch {
      await ctx.reply(text, resolvedMarkup);
    }
  }
}
