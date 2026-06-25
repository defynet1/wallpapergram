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

This is a **clean backend skeleton** — the previous wallpaper-gallery app was stripped down to a reusable base to build something new on top. Single-file backend (`server.js`) + single-file frontend (`public/index.html`). No framework, no bundler.

**server.js** is structured in sections (marked with `// ============`):
1. **Config** — `PORT`, `JWT_SECRET`, `DATABASE_URL` from env vars
2. **Database** — PostgreSQL via `pg` (node-postgres), schema created on startup via `initDb()`. SQL helpers `one() / all() / run()` convert `?` placeholders to `$N` and run against the pool. `withTx(fn)` runs `fn(client)` in a transaction.
3. **SSE (realtime)** — `sseBroadcast(event, data)` to all clients; `sseSendToUser(username, event, data)` to one user's connections. Wired through `GET /api/events` (token via query param, since EventSource can't set headers).
4. **Middleware** — `authMiddleware` (required JWT), `optionalAuth` (JWT if present), `adminOnly` (async DB check)
5. **Routes** — auth (`/api/register`, `/api/login`, `/api/me`), user (`/api/users/:username`), admin (`/api/admin/*`). All async.

**What was kept from the old app:** the server backbone — Express setup, PostgreSQL connection + helpers, SSE infra, JWT auth (register/login/me), the `users` table, and admin role management. **What was removed:** posts, votes, comments, follows, views, chats/messages, shop, orders, coins, categories, file uploads (multer/`/uploads`), and the bot engine.

**Database schema:**
- `users` — `username` TEXT UNIQUE (lookups use `LOWER(username) = LOWER(?)` for case-insensitive semantics), `password_hash`, `avatar`, `is_admin`/`is_verified` (INTEGER 0/1), `created_at` BIGINT. That's the only table; add new ones in `initDb()`.

**PG-specific patterns:**
- Case-insensitive comparisons: `WHERE LOWER(username) = LOWER(?)` (no `COLLATE NOCASE`)
- Search: `ILIKE` (not `LIKE`, which is case-sensitive in PG)
- Upsert ignore: `ON CONFLICT (cols) DO NOTHING` (not `INSERT OR IGNORE`)
- Counts cast: `COUNT(*)::int as c` so node-pg returns JS number, not string from BIGINT
- `BIGINT` (OID 20) parser is overridden globally to return JS `number` since our timestamps fit safely

**Admin access:** Activated via `POST /api/admin/promo` with hardcoded code `defyneter` (change it per project). Admin-only endpoints: list users, verify/unverify users, self-revoke admin.

**Frontend (`public/index.html`):** Minimal single-page placeholder, vanilla JS, no framework. Demonstrates the kept auth flow (register / login / `/api/me`). Auth token stored in `localStorage`. Replace with the real UI for the new project.

## Railway deployment

- Attach a **PostgreSQL** service — Railway auto-provides `DATABASE_URL`
- Required env vars: `JWT_SECRET` (random 32+ char string)
- `PORT` is set automatically by Railway
- Note: the upload/Volume setup from the old app was removed. If the new project stores files, re-add `multer`, a `/uploads` static route, and a mounted Volume (`DATA_MOUNT_PATH`).
