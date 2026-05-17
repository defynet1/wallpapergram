# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # install dependencies
node server.js    # start server (localhost:3000)
npm start         # same, used by Railway
```

No build step, no tests, no linter configured.

## Architecture

Single-file backend (`server.js`) + single-file frontend (`public/index.html`). No framework, no bundler.

**server.js** is structured in sections (marked with `// ============`):
1. **Config** — `PORT`, `JWT_SECRET`, `DATA_DIR` from env vars
2. **Database** — SQLite via `better-sqlite3`, schema created on startup, migrations via try/catch ALTER TABLE
3. **Middleware** — `authMiddleware` (required JWT), `optionalAuth` (JWT if present), `adminOnly`
4. **Routes** — `/api/register`, `/api/login`, `/api/me`, `/api/posts`, `/api/users`, `/api/follow`, `/api/categories`, `/api/admin/*`
5. **Bot engine** — fake users that vote/view real posts on a 30s interval to simulate activity

**Data storage:**
- SQLite at `$DATA_DIR/db.sqlite` (`data/db.sqlite` locally, Railway volume mount in prod)
- Uploaded images at `$DATA_DIR/uploads/` — served statically at `/uploads/*`
- `RAILWAY_VOLUME_MOUNT_PATH` env var controls the data directory in production

**Database schema:**
- `users` — username (case-insensitive), password_hash, avatar, is_admin, is_verified, is_bot
- `posts` — id (base36+hex), author, title, description, image_path, categories (JSON string), quality (0–1 float)
- `votes` — one per (post_id, username), options: `love/like/meh/nope`, upsertable
- `comments`, `follows`, `views` (one per viewer per post), `categories`

**Bot system:** `BOT_NAMES` list of 56 accounts created as `is_bot=1`. `botTick()` runs every 30s — picks random bots, adds views and votes to recent posts. Vote distribution depends on `post.quality` field set at upload time. Boost users (admin-injected fake votes/followers) use `password_hash = '!boost!'` to distinguish them from real users.

**Admin access:** Activated via `POST /api/admin/promo` with hardcoded code `defyneter`. Admin-only endpoints: verify users, boost votes/followers, list/delete all posts.

**Frontend (`public/index.html`):** Single-page app, vanilla JS, no framework. Uses CSS custom properties for theming (dark blue palette). Page routing is done by toggling `.active` class on `.page` divs. Auth token stored in `localStorage`.

## Railway deployment

- Mount a Volume at `/data` — otherwise SQLite and uploads are lost on redeploy
- Required env var: `JWT_SECRET` (random 32+ char string)
- `PORT` is set automatically by Railway
