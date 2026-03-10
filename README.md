# PixivAutoPost

Telegram-бот на TypeScript/Telegraf для автопостинга артов из Pixiv в два канала: `SFW` и `NSFW`.

## Возможности

- автопост по расписанию в отдельные SFW/NSFW каналы;
- ручной постинг из ЛС бота;
- постинг по Pixiv-ссылке с выбором канала, числа страниц и случайной выборкой;
- разбиение длинных Pixiv-постов на несколько частей;
- отправка оригиналов в комментарии к каждому посту;
- поддержка `ugoira` с конвертацией в GIF;
- простая админка на inline-кнопках;
- запуск через Docker Compose.

## Стек

- Node.js 22
- TypeScript
- Telegraf
- pixiv-api-client
- ffmpeg

## Структура

- [`src/`](/opt/PixivAutoBot/src) — исходники
- [`data/`](/opt/PixivAutoBot/data) — локальные runtime-конфиги и состояние, в git не коммитятся
- [`.env.example`](/opt/PixivAutoBot/.env.example) — шаблон переменных окружения
- [`docker-compose.yml`](/opt/PixivAutoBot/docker-compose.yml) — основной способ запуска

## Переменные окружения

Обязательные:

- `BOT_TOKEN`
- `PIXIV_REFRESH_TOKEN`
- `SFW_CHANNEL_ID`
- `NSFW_CHANNEL_ID`

Опциональные:

- `PIXIV_ACCESS_TOKEN`
- `PIXIV_USERNAME`
- `PIXIV_PASSWORD`
- `ADMIN_IDS`
- `PROTECTED_ADMIN_IDS`
- `ORIGINAL_REPLY_DELAY_MS`

## Данные

Боевые файлы из `data/` намеренно не входят в репозиторий. На первом запуске бот сам создаёт:

- `data/sfw.json`
- `data/nsfw.json`
- `data/admins.json`

Для ориентира в репозитории лежат безопасные шаблоны:

- [`data/sfw.example.json`](/opt/PixivAutoBot/data/sfw.example.json)
- [`data/nsfw.example.json`](/opt/PixivAutoBot/data/nsfw.example.json)
- [`data/admins.example.json`](/opt/PixivAutoBot/data/admins.example.json)

## Запуск через Docker Compose

1. Создайте локальный `.env` на основе `.env.example`.
2. При необходимости заполните стартовые данные в `data/*.json` или дайте боту создать их самому.
3. Запустите:

```bash
docker compose up -d --build
```

Остановка:

```bash
docker compose stop
```

Логи:

```bash
docker compose logs -f
```

## Локальная разработка

```bash
npm install
npm run build
npm start
```

## Публикация

В git исключены:

- `.env`
- `data/*.json`
- `dist/`
- `node_modules/`
- временные и лог-файлы

Перед публикацией всё равно стоит заменить реальные токены и пароли, если они когда-либо хранились в рабочей директории.
