# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                                    # install dependencies
DATABASE_URL=postgres://... node server.js     # start server locally
npm start                                      # used by Railway
```

No build step, no tests, no linter configured.

## Architecture

Single-file backend (`server.js`) + single-file frontend (`public/index.html`). No framework, no bundler.

**server.js** is structured in sections (marked with `// ============`):
1. **Config** — `PORT`, `JWT_SECRET`, `DATA_DIR`, `DATABASE_URL` from env vars
2. **Database** — PostgreSQL via `pg` (node-postgres), schema created on startup via `initDb()`. SQL helpers `one() / all() / run()` convert `?` placeholders to `$N` and run against the pool. `withTx(fn)` runs `fn(client)` in a transaction.
3. **Middleware** — `authMiddleware` (required JWT), `optionalAuth` (JWT if present), `adminOnly` (async DB check)
4. **Routes** — `/api/register`, `/api/login`, `/api/me`, `/api/posts`, `/api/users`, `/api/follow`, `/api/categories`, `/api/admin/*`. All async.
5. **Bot engine** — fake users that vote/view real posts on a 30s interval. `botTickRunning` flag prevents overlapping ticks.

**Data storage:**
- PostgreSQL via `DATABASE_URL` env var (Railway provides this when you attach a PostgreSQL service)
- Uploaded images at `$DATA_DIR/uploads/` — served statically at `/uploads/*`
- `DATA_MOUNT_PATH` or `RAILWAY_VOLUME_MOUNT_PATH` env var controls the upload directory in production

**Database schema:**
- `users` — username TEXT UNIQUE (case-sensitive in column, but ALL lookups use `LOWER(username) = LOWER(?)` to preserve case-insensitive semantics from the SQLite era), password_hash, avatar, is_admin/is_verified/is_bot (INTEGER 0/1), created_at BIGINT
- `posts` — id (base36+hex string), author, title, description, image_path, categories (JSON string), quality (REAL 0–1), bots_paused (INTEGER 0/1), created_at BIGINT
- `votes` — PK `(post_id, username)`, options: `love/like/meh/nope`, upsertable via `ON CONFLICT (post_id, username) DO UPDATE SET option = EXCLUDED.option`
- `comments`, `follows`, `views` (PK per viewer per post), `categories`

**PG-specific patterns:**
- Case-insensitive comparisons: `WHERE LOWER(username) = LOWER(?)` (no `COLLATE NOCASE`)
- Search: `ILIKE` (not `LIKE`, which is case-sensitive in PG)
- Upsert ignore: `ON CONFLICT (cols) DO NOTHING` (not `INSERT OR IGNORE`)
- Counts cast: `COUNT(*)::int as c` so node-pg returns JS number, not string from BIGINT
- `BIGINT` (OID 20) parser is overridden globally to return JS `number` since our timestamps fit safely

**Bot system:** `BOT_NAMES` list of 56 accounts created as `is_bot=1`. `botTick()` runs every 30s — picks random bots, adds views and votes to recent posts where `bots_paused = 0`. Vote distribution depends on `post.quality` field set at upload time. Boost users (admin-injected fake votes/followers) use `password_hash = '!boost!'`; admin-created users (via post-as) use `'!admin-created!'`.

**Admin access:** Activated via `POST /api/admin/promo` with hardcoded code `defyneter`. Admin-only endpoints: verify users, boost votes/followers, list/delete all posts, publish as any user, pause/resume bots per post, strip bot votes from a post.

**Frontend (`public/index.html`):** Single-page app, vanilla JS, no framework. Uses CSS custom properties for theming (dark blue palette). Page routing is done by toggling `.active` class on `.page` divs. Auth token stored in `localStorage`.

## Railway deployment

- Attach a **PostgreSQL** service — Railway auto-provides `DATABASE_URL`
- Mount a Volume for uploads — otherwise uploaded images are lost on redeploy
- Required env vars: `JWT_SECRET` (random 32+ char string), `DATA_MOUNT_PATH` (path to the mounted volume, e.g. `/data`)
- `PORT` is set automatically by Railway
