# Changelog

## [1.0.2] - 2026-03-10

- fixed GitHub release workflow packaging so the archive is created outside the repo tree;
- release artifacts now publish from `/tmp` to avoid `tar` including the output archive in itself.

## [1.0.1] - 2026-03-10

- added GitHub Actions CI workflow for build verification on `main` and pull requests;
- added GitHub Actions release workflow for automatic GitHub Releases on `v*` tags;
- automated release artifact packaging without local secrets or runtime data.

## [1.0.0] - 2026-03-10

- initial open-source release of the Pixiv auto-posting Telegram bot;
- SFW and NSFW channel separation with independent schedules;
- Telegram admin panel for manual uploads and author/admin management;
- Pixiv link posting with page count selection, random selection, and chunked multi-post publishing;
- original files sent to linked discussion comments;
- ugoira to GIF conversion with original frame archive delivery;
- Docker Compose deployment and publishable repository cleanup.
