// ============ WALLPAPERS BACKEND ============
// PostgreSQL on Railway. Картинки на диске (Railway Volume).
// Запуск локально: DATABASE_URL=postgres://... node server.js

const express = require('express');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// BIGINT (OID 20) — парсим как number. Наши значения (timestamps миллисекунд) умещаются в Number.
types.setTypeParser(20, val => val === null ? null : parseInt(val, 10));

const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA_DIR = process.env.DATA_MOUNT_PATH || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ============ DATABASE ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Конвертирует SQLite-style ? в PG-style $1, $2, ...
function pg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function one(sql, ...params) {
  const r = await pool.query(pg(sql), params);
  return r.rows[0] || null;
}
async function all(sql, ...params) {
  const r = await pool.query(pg(sql), params);
  return r.rows;
}
async function run(sql, ...params) {
  const r = await pool.query(pg(sql), params);
  return { changes: r.rowCount };
}
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT,
      is_admin INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      is_bot INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      image_path TEXT NOT NULL,
      categories TEXT NOT NULL,
      quality REAL,
      bots_paused INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);

    CREATE TABLE IF NOT EXISTS votes (
      post_id TEXT NOT NULL,
      username TEXT NOT NULL,
      option TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (post_id, username)
    );
    CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

    CREATE TABLE IF NOT EXISTS follows (
      follower TEXT NOT NULL,
      followed TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (follower, followed)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed);

    CREATE TABLE IF NOT EXISTS categories (
      tag TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      is_custom INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS views (
      post_id TEXT NOT NULL,
      viewer TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (post_id, viewer)
    );
    CREATE INDEX IF NOT EXISTS idx_views_post ON views(post_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      read_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender, receiver, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_receiver_unread ON messages (receiver) WHERE read_at IS NULL;

    CREATE TABLE IF NOT EXISTS shop_listings (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      price BIGINT NOT NULL,
      images TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shop_created ON shop_listings(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_author ON shop_listings(author);

    CREATE TABLE IF NOT EXISTS shop_orders (
      id TEXT PRIMARY KEY,
      listing_id TEXT,
      listing_title TEXT NOT NULL,
      buyer TEXT NOT NULL,
      seller TEXT NOT NULL,
      price BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      completed_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON shop_orders(buyer, status);
    CREATE INDEX IF NOT EXISTS idx_orders_seller ON shop_orders(seller, status);
  `);
  // Миграция: баннер у объявлений
  try { await pool.query("ALTER TABLE shop_listings ADD COLUMN banner TEXT"); } catch (e) {}
  // Миграция: монеты у юзеров, валюта у объявлений
  try { await pool.query("ALTER TABLE users ADD COLUMN coins BIGINT DEFAULT 0"); } catch (e) {}
  try { await pool.query("ALTER TABLE shop_listings ADD COLUMN currency TEXT DEFAULT 'rub'"); } catch (e) {}
  // Миграция: авто-ответ при покупке
  try { await pool.query("ALTER TABLE users ADD COLUMN auto_reply TEXT"); } catch (e) {}
  // Миграция: баннер профиля
  try { await pool.query("ALTER TABLE users ADD COLUMN banner TEXT"); } catch (e) {}
  // Миграции: type на постах, kind на категориях (для обоев/аватарок)
  try { await pool.query("ALTER TABLE posts ADD COLUMN type TEXT DEFAULT 'wallpaper'"); } catch (e) {}
  try { await pool.query("ALTER TABLE categories ADD COLUMN kind TEXT DEFAULT 'wallpaper'"); } catch (e) {}

  // Встроенная категория «живые обои»
  await pool.query(
    "INSERT INTO categories (tag, label, is_custom, kind) VALUES ('live', '🎬 Живые', 0, 'wallpaper') ON CONFLICT (tag) DO NOTHING"
  );

  // Встроенные категории для аватарок
  const avatarBuiltins = [
    ['telegram', '💬 Telegram'],
    ['standoff', '🎯 Standoff'],
    ['games', '🎮 Игры'],
    ['facebook', '📘 Facebook'],
  ];
  for (const [tag, label] of avatarBuiltins) {
    await pool.query(
      "INSERT INTO categories (tag, label, is_custom, kind) VALUES ($1, $2, 0, 'avatar') ON CONFLICT (tag) DO NOTHING",
      [tag, label]
    );
  }
}

function isAnimated(mimetype) {
  if (!mimetype) return false;
  return mimetype.startsWith('video/') || mimetype === 'image/gif';
}

// ============ SSE (REALTIME) ============
const sseClients = new Set();
const userSseClients = new Map(); // username (lowercase) → Set<res>

function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) {}
  }
}

function sseSendToUser(username, event, data) {
  if (!username) return;
  const key = username.toLowerCase();
  const set = userSseClients.get(key);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch (e) {}
  }
}

async function postCounts(postId) {
  const votes = await all('SELECT option, COUNT(*)::int as c FROM votes WHERE post_id = ? GROUP BY option', postId);
  const tally = { love: 0, like: 0, meh: 0, nope: 0 };
  votes.forEach(v => { if (tally[v.option] !== undefined) tally[v.option] = v.c; });
  const commentsCount = (await one('SELECT COUNT(*)::int as c FROM comments WHERE post_id = ?', postId)).c;
  const viewsCount = (await one('SELECT COUNT(*)::int as c FROM views WHERE post_id = ?', postId)).c;
  return { id: postId, votes: tally, comments_count: commentsCount, views_count: viewsCount };
}

// ============ APP SETUP ============
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  }
});
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB — хватит и на короткие mp4/webm
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else if (ALLOWED_VIDEO_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only images and videos allowed'));
  }
});

// ============ AUTH MIDDLEWARE ============
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) {}
  }
  next();
}

async function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Auth required' });
  try {
    const u = await one('SELECT is_admin FROM users WHERE username = ?', req.user.username);
    if (!u || !u.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
}

// ============ SSE ENDPOINT ============
app.get('/api/events', (req, res) => {
  // Авторизация по токену в URL (EventSource не умеет кастомные заголовки)
  let username = null;
  const token = req.query.token;
  if (token) {
    try { username = jwt.verify(token, JWT_SECRET).username; } catch (e) {}
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');

  const keepalive = setInterval(() => {
    try { res.write(': ka\n\n'); } catch (e) {}
  }, 25000);

  sseClients.add(res);
  let userKey = null;
  if (username) {
    userKey = username.toLowerCase();
    if (!userSseClients.has(userKey)) userSseClients.set(userKey, new Set());
    userSseClients.get(userKey).add(res);
  }

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
    if (userKey) {
      const set = userSseClients.get(userKey);
      if (set) {
        set.delete(res);
        if (!set.size) userSseClients.delete(userKey);
      }
    }
  });
});

// ============ AUTH ROUTES ============
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || username.length < 2 || username.length > 20)
      return res.status(400).json({ error: 'Username 2-20 chars' });
    if (!/^[a-zA-Zа-яА-Я0-9_]+$/.test(username))
      return res.status(400).json({ error: 'Only letters, digits, _' });
    if (!password || password.length < 4)
      return res.status(400).json({ error: 'Password min 4 chars' });

    const exists = await one('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)', username);
    if (exists) return res.status(409).json({ error: 'Username taken' });

    const hash = await bcrypt.hash(password, 10);
    await run('INSERT INTO users (username, password_hash, created_at, coins) VALUES (?, ?, ?, 100)', username, hash, Date.now());

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const user = await one('SELECT username, password_hash FROM users WHERE LOWER(username) = LOWER(?)', username);
    if (!user) return res.status(401).json({ error: 'Wrong username or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong username or password' });

    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const u = await one('SELECT username, avatar, banner, is_admin, is_verified, created_at, COALESCE(coins, 0)::int as coins, auto_reply FROM users WHERE username = ?', req.user.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// Установить/убрать авто-ответ при покупке (пустая строка = выключить)
app.put('/api/me/auto-reply', authMiddleware, async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
  await run('UPDATE users SET auto_reply = ? WHERE username = ?', text || null, req.user.username);
  res.json({ ok: true, auto_reply: text || null });
});

// Текущий баланс монет (для лёгких опросов)
app.get('/api/me/coins', authMiddleware, async (req, res) => {
  const u = await one('SELECT COALESCE(coins, 0)::int as coins FROM users WHERE username = ?', req.user.username);
  res.json({ coins: u ? u.coins : 0 });
});

// ============ USER ROUTES ============
app.get('/api/users/:username', async (req, res) => {
  const u = await one('SELECT username, avatar, banner, is_verified, created_at FROM users WHERE LOWER(username) = LOWER(?)', req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });

  const postsCount = (await one('SELECT COUNT(*)::int as c FROM posts WHERE LOWER(author) = LOWER(?)', req.params.username)).c;
  const followers = (await one('SELECT COUNT(*)::int as c FROM follows WHERE followed = ?', req.params.username.toLowerCase())).c;
  const following = (await one('SELECT COUNT(*)::int as c FROM follows WHERE follower = ?', req.params.username.toLowerCase())).c;

  res.json({ ...u, posts: postsCount, followers, following });
});

app.put('/api/me/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  await run('UPDATE users SET avatar = ? WHERE username = ?', url, req.user.username);
  res.json({ avatar: url });
});

app.put('/api/me/banner', authMiddleware, upload.single('banner'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  // Удалим старый баннер с диска
  const prev = await one('SELECT banner FROM users WHERE username = ?', req.user.username);
  if (prev && prev.banner && prev.banner.startsWith('/uploads/')) {
    const fp = path.join(UPLOADS_DIR, path.basename(prev.banner));
    fs.promises.unlink(fp).catch(() => {});
  }
  await run('UPDATE users SET banner = ? WHERE username = ?', url, req.user.username);
  res.json({ banner: url });
});

app.delete('/api/me/banner', authMiddleware, async (req, res) => {
  const prev = await one('SELECT banner FROM users WHERE username = ?', req.user.username);
  if (prev && prev.banner && prev.banner.startsWith('/uploads/')) {
    const fp = path.join(UPLOADS_DIR, path.basename(prev.banner));
    fs.promises.unlink(fp).catch(() => {});
  }
  await run('UPDATE users SET banner = NULL WHERE username = ?', req.user.username);
  res.json({ ok: true });
});

// ============ POSTS ============
async function enrichPost(p, currentUsername) {
  const votes = await all('SELECT option, COUNT(*)::int as c FROM votes WHERE post_id = ? GROUP BY option', p.id);
  const tally = { love: 0, like: 0, meh: 0, nope: 0 };
  votes.forEach(v => { if (tally[v.option] !== undefined) tally[v.option] = v.c; });

  const commentsCount = (await one('SELECT COUNT(*)::int as c FROM comments WHERE post_id = ?', p.id)).c;
  const viewsCount = (await one('SELECT COUNT(*)::int as c FROM views WHERE post_id = ?', p.id)).c;

  let myVote = null;
  if (currentUsername) {
    const v = await one('SELECT option FROM votes WHERE post_id = ? AND username = ?', p.id, currentUsername);
    myVote = v ? v.option : null;
  }

  return {
    id: p.id,
    author: p.author,
    author_avatar: p.author_avatar,
    author_verified: !!p.author_verified,
    title: p.title,
    description: p.description,
    image: p.image_path,
    categories: JSON.parse(p.categories || '[]'),
    created_at: p.created_at,
    votes: tally,
    comments_count: commentsCount,
    views_count: viewsCount,
    my_vote: myVote
  };
}

app.get('/api/posts', optionalAuth, async (req, res) => {
  try {
    const { search = '', category = '', limit = 50, before, type } = req.query;
    const postType = (type === 'avatar') ? 'avatar' : 'wallpaper';

    let sql = `SELECT p.*, u.is_verified as author_verified, u.avatar as author_avatar
               FROM posts p
               LEFT JOIN users u ON u.username = p.author
               WHERE COALESCE(p.type, 'wallpaper') = ?`;
    const params = [postType];

    if (before) {
      sql += ' AND p.created_at < ?';
      params.push(parseInt(before, 10));
    }
    if (search) {
      sql += ' AND (p.title ILIKE ? OR p.description ILIKE ? OR p.author ILIKE ? OR p.categories ILIKE ?)';
      const like = '%' + search + '%';
      params.push(like, like, like, like);
    }
    if (category) {
      sql += ' AND p.categories LIKE ?';
      params.push('%"' + category + '"%');
    }

    sql += ' ORDER BY p.created_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit, 10) || 50, 100));

    const rows = await all(sql, ...params);
    const result = await Promise.all(rows.map(p => enrichPost(p, req.user && req.user.username)));
    res.json(result);
  } catch (e) {
    console.error('get posts error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/posts', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });

    const title = (req.body.title || '').trim().slice(0, 60);
    if (!title) return res.status(400).json({ error: 'Title required' });

    const description = (req.body.description || '').trim().slice(0, 200);
    let categories;
    try { categories = JSON.parse(req.body.categories || '[]'); }
    catch (e) { return res.status(400).json({ error: 'Invalid categories' }); }
    if (!Array.isArray(categories) || categories.length < 3)
      return res.status(400).json({ error: 'Need at least 3 categories' });

    const postType = (req.body.type === 'avatar') ? 'avatar' : 'wallpaper';

    if (postType === 'wallpaper' && isAnimated(req.file.mimetype) && !categories.includes('live')) {
      categories = ['live', ...categories];
    }

    const quality = parseFloat(req.body.quality) || null;
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const imagePath = '/uploads/' + req.file.filename;

    await run(
      `INSERT INTO posts (id, author, title, description, image_path, categories, quality, created_at, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, req.user.username, title, description, imagePath, JSON.stringify(categories), quality, Date.now(), postType
    );
    sseBroadcast('new-post', { id, type: postType });
    res.json({ id });
  } catch (e) {
    console.error('create post error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  const post = await one('SELECT author, image_path FROM posts WHERE id = ?', req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });

  const me = await one('SELECT is_admin FROM users WHERE username = ?', req.user.username);
  const isMine = post.author.toLowerCase() === req.user.username.toLowerCase();
  if (!isMine && !(me && me.is_admin))
    return res.status(403).json({ error: 'Forbidden' });

  if (post.image_path && post.image_path.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, path.basename(post.image_path));
    fs.promises.unlink(filePath).catch(() => {});
  }

  await run('DELETE FROM posts WHERE id = ?', req.params.id);
  await run('DELETE FROM votes WHERE post_id = ?', req.params.id);
  await run('DELETE FROM comments WHERE post_id = ?', req.params.id);
  await run('DELETE FROM views WHERE post_id = ?', req.params.id);
  sseBroadcast('delete-post', { id: req.params.id });
  res.json({ ok: true });
});

app.get('/api/users/:username/posts', optionalAuth, async (req, res) => {
  const rows = await all(`
    SELECT p.*, u.is_verified as author_verified, u.avatar as author_avatar
    FROM posts p LEFT JOIN users u ON u.username = p.author
    WHERE LOWER(p.author) = LOWER(?)
    ORDER BY p.created_at DESC LIMIT 100
  `, req.params.username);

  const result = await Promise.all(rows.map(p => enrichPost(p, req.user && req.user.username)));
  res.json(result);
});

// ============ VIEWS ============
app.post('/api/posts/:id/view', authMiddleware, async (req, res) => {
  const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const result = await run(
    'INSERT INTO views (post_id, viewer, created_at) VALUES (?, ?, ?) ON CONFLICT (post_id, viewer) DO NOTHING',
    req.params.id, req.user.username.toLowerCase(), Date.now()
  );
  if (result.changes > 0) {
    sseBroadcast('update', await postCounts(req.params.id));
  }
  res.json({ ok: true });
});

// ============ VOTES ============
app.post('/api/posts/:id/vote', authMiddleware, async (req, res) => {
  const { option } = req.body || {};
  const valid = ['love', 'like', 'meh', 'nope'];
  if (!valid.includes(option)) return res.status(400).json({ error: 'Bad option' });

  const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  await run(
    `INSERT INTO votes (post_id, username, option, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (post_id, username) DO UPDATE SET option = EXCLUDED.option`,
    req.params.id, req.user.username, option, Date.now()
  );
  sseBroadcast('update', await postCounts(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/posts/:id/vote', authMiddleware, async (req, res) => {
  await run('DELETE FROM votes WHERE post_id = ? AND username = ?', req.params.id, req.user.username);
  sseBroadcast('update', await postCounts(req.params.id));
  res.json({ ok: true });
});

// ============ COMMENTS ============
app.get('/api/posts/:id/comments', async (req, res) => {
  const rows = await all(`
    SELECT c.*, u.avatar as author_avatar, u.is_verified as author_verified
    FROM comments c LEFT JOIN users u ON u.username = c.author
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `, req.params.id);
  res.json(rows.map(r => ({
    id: r.id, author: r.author, text: r.text, created_at: r.created_at,
    author_avatar: r.author_avatar, author_verified: !!r.author_verified
  })));
});

app.post('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  const text = (req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Empty comment' });

  const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  await run(
    'INSERT INTO comments (id, post_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)',
    id, req.params.id, req.user.username, text, Date.now()
  );
  sseBroadcast('update', await postCounts(req.params.id));
  res.json({ id });
});

app.delete('/api/comments/:id', authMiddleware, async (req, res) => {
  const c = await one(
    'SELECT c.*, p.author as post_author FROM comments c LEFT JOIN posts p ON p.id = c.post_id WHERE c.id = ?',
    req.params.id
  );
  if (!c) return res.status(404).json({ error: 'Not found' });

  const me = await one('SELECT is_admin FROM users WHERE username = ?', req.user.username);
  const isAuthor = c.author.toLowerCase() === req.user.username.toLowerCase();
  const isPostAuthor = c.post_author && c.post_author.toLowerCase() === req.user.username.toLowerCase();
  if (!isAuthor && !isPostAuthor && !(me && me.is_admin))
    return res.status(403).json({ error: 'Forbidden' });

  await run('DELETE FROM comments WHERE id = ?', req.params.id);
  sseBroadcast('update', await postCounts(c.post_id));
  res.json({ ok: true });
});

// ============ FOLLOWS ============
app.post('/api/follow/:username', authMiddleware, async (req, res) => {
  const target = req.params.username.toLowerCase();
  const me = req.user.username.toLowerCase();
  if (target === me) return res.status(400).json({ error: 'Cannot follow yourself' });

  const exists = await one('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)', req.params.username);
  if (!exists) return res.status(404).json({ error: 'User not found' });

  await run(
    'INSERT INTO follows (follower, followed, created_at) VALUES (?, ?, ?) ON CONFLICT (follower, followed) DO NOTHING',
    me, target, Date.now()
  );
  res.json({ ok: true });
});

app.delete('/api/follow/:username', authMiddleware, async (req, res) => {
  await run(
    'DELETE FROM follows WHERE follower = ? AND followed = ?',
    req.user.username.toLowerCase(), req.params.username.toLowerCase()
  );
  res.json({ ok: true });
});

app.get('/api/follow/check/:username', authMiddleware, async (req, res) => {
  const r = await one(
    'SELECT 1 FROM follows WHERE follower = ? AND followed = ?',
    req.user.username.toLowerCase(), req.params.username.toLowerCase()
  );
  res.json({ following: !!r });
});

app.get('/api/users/:username/followers', async (req, res) => {
  const rows = await all(`
    SELECT u.username, u.avatar, u.is_verified FROM follows f
    JOIN users u ON LOWER(u.username) = f.follower
    WHERE f.followed = ? ORDER BY f.created_at DESC LIMIT 200
  `, req.params.username.toLowerCase());
  res.json(rows);
});

app.get('/api/users/:username/following', async (req, res) => {
  const rows = await all(`
    SELECT u.username, u.avatar, u.is_verified FROM follows f
    JOIN users u ON LOWER(u.username) = f.followed
    WHERE f.follower = ? ORDER BY f.created_at DESC LIMIT 200
  `, req.params.username.toLowerCase());
  res.json(rows);
});

// ============ CHATS / MESSAGES ============
async function canSendMessage(senderLc, receiverLc) {
  if (senderLc === receiverLc) return false;
  // Можно писать если подписан на получателя ИЛИ уже есть переписка ИЛИ у получателя есть объявления в shop
  const follows = await one('SELECT 1 FROM follows WHERE follower = ? AND followed = ?', senderLc, receiverLc);
  if (follows) return true;
  const prior = await one('SELECT 1 FROM messages WHERE sender = ? AND receiver = ? LIMIT 1', receiverLc, senderLc);
  if (prior) return true;
  const hasShop = await one('SELECT 1 FROM shop_listings WHERE LOWER(author) = ? LIMIT 1', receiverLc);
  return !!hasShop;
}

// Список моих диалогов: последнее сообщение с каждым собеседником + непрочитанные
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = req.user.username.toLowerCase();
    const latest = await all(`
      SELECT DISTINCT ON (peer) peer, id, sender, receiver, text, created_at, read_at
      FROM (
        SELECT CASE WHEN sender = ? THEN receiver ELSE sender END as peer,
               id, sender, receiver, text, created_at, read_at
        FROM messages WHERE sender = ? OR receiver = ?
      ) sub
      ORDER BY peer, created_at DESC
    `, me, me, me);

    // Сортируем по времени и подгружаем юзер-инфу
    latest.sort((a, b) => b.created_at - a.created_at);
    const result = await Promise.all(latest.map(async m => {
      const u = await one('SELECT username, avatar, is_verified FROM users WHERE LOWER(username) = ?', m.peer);
      const unread = (await one(
        'SELECT COUNT(*)::int as c FROM messages WHERE sender = ? AND receiver = ? AND read_at IS NULL',
        m.peer, me
      )).c;
      return {
        peer: u ? u.username : m.peer,
        peer_avatar: u ? u.avatar : null,
        peer_verified: u ? !!u.is_verified : false,
        last_text: m.text,
        last_at: m.created_at,
        last_sender: m.sender,
        unread
      };
    }));
    res.json(result);
  } catch (e) {
    console.error('GET /api/chats error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// История диалога с конкретным юзером (и помечает входящие как прочитанные)
app.get('/api/chats/:username', authMiddleware, async (req, res) => {
  try {
    const me = req.user.username.toLowerCase();
    const peer = req.params.username.toLowerCase();
    if (me === peer) return res.status(400).json({ error: 'Self chat not allowed' });

    const rows = await all(`
      SELECT id, sender, receiver, text, created_at, read_at FROM messages
      WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
      ORDER BY created_at ASC LIMIT 500
    `, me, peer, peer, me);

    // Помечаем входящие как прочитанные
    await run(
      'UPDATE messages SET read_at = ? WHERE sender = ? AND receiver = ? AND read_at IS NULL',
      Date.now(), peer, me
    );

    const u = await one('SELECT username, avatar, is_verified FROM users WHERE LOWER(username) = ?', peer);
    const canWrite = await canSendMessage(me, peer);
    res.json({
      peer: u ? u.username : req.params.username,
      peer_avatar: u ? u.avatar : null,
      peer_verified: u ? !!u.is_verified : false,
      can_write: canWrite,
      messages: rows
    });
  } catch (e) {
    console.error('GET /api/chats/:user error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Отправить сообщение
app.post('/api/chats/:username', authMiddleware, async (req, res) => {
  try {
    const me = req.user.username.toLowerCase();
    const peer = req.params.username.toLowerCase();
    if (me === peer) return res.status(400).json({ error: 'Self chat not allowed' });

    const text = (req.body.text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Empty message' });

    const peerUser = await one('SELECT username FROM users WHERE LOWER(username) = ?', peer);
    if (!peerUser) return res.status(404).json({ error: 'User not found' });

    if (!(await canSendMessage(me, peer))) {
      return res.status(403).json({ error: 'Подпишись на этого юзера, чтобы написать ему' });
    }

    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const created_at = Date.now();
    await run(
      'INSERT INTO messages (id, sender, receiver, text, created_at) VALUES (?, ?, ?, ?, ?)',
      id, me, peer, text, created_at
    );

    const message = { id, sender: me, receiver: peer, text, created_at, read_at: null };
    // Пушим обоим в реалтайме
    sseSendToUser(peer, 'message', { message, from: req.user.username });
    sseSendToUser(me, 'message', { message, from: req.user.username });
    res.json(message);
  } catch (e) {
    console.error('POST /api/chats/:user error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Счётчик непрочитанных
app.get('/api/chats-unread', authMiddleware, async (req, res) => {
  const me = req.user.username.toLowerCase();
  const c = (await one('SELECT COUNT(*)::int as c FROM messages WHERE receiver = ? AND read_at IS NULL', me)).c;
  res.json({ unread: c });
});

// ============ SHOP ============
app.get('/api/shop', async (req, res) => {
  try {
    const { search = '', author } = req.query;
    let sql = `SELECT l.*, u.is_verified as author_verified, u.avatar as author_avatar
               FROM shop_listings l LEFT JOIN users u ON u.username = l.author
               WHERE 1=1`;
    const params = [];
    if (author) {
      sql += ' AND LOWER(l.author) = LOWER(?)';
      params.push(author);
    }
    if (search) {
      sql += ' AND (l.title ILIKE ? OR l.description ILIKE ? OR l.author ILIKE ?)';
      const like = '%' + search + '%';
      params.push(like, like, like);
    }
    sql += ' ORDER BY l.created_at DESC LIMIT 200';
    const rows = await all(sql, ...params);
    res.json(rows.map(r => {
      const images = JSON.parse(r.images || '[]');
      return {
        id: r.id,
        author: r.author,
        author_avatar: r.author_avatar,
        author_verified: !!r.author_verified,
        title: r.title,
        description: r.description,
        price: r.price,
        currency: r.currency || 'rub',
        banner: r.banner || images[0] || null, // старые объявления — fallback на первую картинку
        images,
        created_at: r.created_at
      };
    }));
  } catch (e) {
    console.error('GET /api/shop error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/shop', authMiddleware, upload.fields([
  { name: 'banner', maxCount: 1 },
  { name: 'images', maxCount: 5 }
]), async (req, res) => {
  try {
    const bannerFile = req.files && req.files.banner && req.files.banner[0];
    if (!bannerFile) return res.status(400).json({ error: 'Banner required' });

    const title = (req.body.title || '').trim().slice(0, 80);
    if (!title) return res.status(400).json({ error: 'Title required' });

    const description = (req.body.description || '').trim().slice(0, 1000);
    const price = parseInt(req.body.price, 10);
    if (!Number.isFinite(price) || price < 0 || price > 10000000) {
      return res.status(400).json({ error: 'Price must be 0–10 000 000' });
    }
    const currency = req.body.currency === 'coins' ? 'coins' : 'rub';

    const banner = '/uploads/' + bannerFile.filename;
    const imageFiles = (req.files && req.files.images) || [];
    const images = imageFiles.map(f => '/uploads/' + f.filename);

    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const created_at = Date.now();

    await run(
      `INSERT INTO shop_listings (id, author, title, description, price, images, banner, created_at, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, req.user.username, title, description, price, JSON.stringify(images), banner, created_at, currency
    );
    sseBroadcast('new-listing', { id });
    res.json({ id });
  } catch (e) {
    console.error('POST /api/shop error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/shop/:id/buy', authMiddleware, async (req, res) => {
  try {
    const me = req.user.username;
    const meLc = me.toLowerCase();
    const listing = await one('SELECT * FROM shop_listings WHERE id = ?', req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if ((listing.currency || 'rub') !== 'coins') return res.status(400).json({ error: 'Это объявление в ₽ — нельзя оплатить монетами' });
    if (listing.author.toLowerCase() === meLc) return res.status(400).json({ error: 'Своё объявление покупать нельзя' });

    const price = Number(listing.price) || 0;
    const sellerLc = listing.author.toLowerCase();
    const orderId = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const msgId = orderId + '_buy';
    const ts = Date.now();
    const msgText = `🛍 Заказал(а) «${listing.title}» за ${price} 🪙 — деньги удержаны, продавец получит их после подтверждения покупателем.`;

    let newBalance = null;
    let messageRow = null;
    let autoReplyRow = null;
    try {
      await withTx(async (client) => {
        const r = await client.query(
          'UPDATE users SET coins = coins - $1 WHERE LOWER(username) = $2 AND coins >= $1 RETURNING coins',
          [price, meLc]
        );
        if (!r.rowCount) throw new Error('Недостаточно монет');
        newBalance = parseInt(r.rows[0].coins, 10);
        // Деньги уходят в эскроу — заказ в статусе pending. Продавцу пока ничего.
        await client.query(
          `INSERT INTO shop_orders (id, listing_id, listing_title, buyer, seller, price, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
          [orderId, listing.id, listing.title, meLc, sellerLc, price, ts]
        );
        await client.query(
          'INSERT INTO messages (id, sender, receiver, text, created_at) VALUES ($1, $2, $3, $4, $5)',
          [msgId, meLc, sellerLc, msgText, ts]
        );
        messageRow = { id: msgId, sender: meLc, receiver: sellerLc, text: msgText, created_at: ts, read_at: null };

        // Авто-ответ продавца, если настроен
        const seller = await client.query('SELECT auto_reply FROM users WHERE LOWER(username) = $1', [sellerLc]);
        const reply = seller.rows[0] && seller.rows[0].auto_reply;
        if (reply && reply.trim()) {
          const arId = orderId + '_ar';
          const arTs = ts + 1;
          await client.query(
            'INSERT INTO messages (id, sender, receiver, text, created_at) VALUES ($1, $2, $3, $4, $5)',
            [arId, sellerLc, meLc, reply, arTs]
          );
          autoReplyRow = { id: arId, sender: sellerLc, receiver: meLc, text: reply, created_at: arTs, read_at: null };
        }
      });
    } catch (e) {
      if (e.message === 'Недостаточно монет') return res.status(402).json({ error: e.message });
      throw e;
    }

    if (messageRow) {
      sseSendToUser(sellerLc, 'message', { message: messageRow, from: me });
      sseSendToUser(meLc, 'message', { message: messageRow, from: me });
    }
    if (autoReplyRow) {
      sseSendToUser(sellerLc, 'message', { message: autoReplyRow, from: listing.author });
      sseSendToUser(meLc, 'message', { message: autoReplyRow, from: listing.author });
    }
    // Уведомление об изменении заказа — оба обновят список pending в открытом чате
    sseSendToUser(sellerLc, 'order-changed', { peer: me });
    sseSendToUser(meLc, 'order-changed', { peer: listing.author });
    res.json({ ok: true, coins: newBalance, peer: listing.author, orderId });
  } catch (e) {
    console.error('POST /api/shop/:id/buy error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Список pending-заказов между мной и собеседником (обе стороны)
app.get('/api/orders/pending-with/:username', authMiddleware, async (req, res) => {
  try {
    const meLc = req.user.username.toLowerCase();
    const peerLc = req.params.username.toLowerCase();
    const rows = await all(`
      SELECT id, listing_id, listing_title, buyer, seller, price, created_at
      FROM shop_orders
      WHERE status = 'pending'
        AND ((buyer = ? AND seller = ?) OR (buyer = ? AND seller = ?))
      ORDER BY created_at ASC
    `, meLc, peerLc, peerLc, meLc);
    res.json(rows.map(o => ({
      id: o.id,
      listing_id: o.listing_id,
      listing_title: o.listing_title,
      buyer: o.buyer,
      seller: o.seller,
      price: o.price,
      created_at: o.created_at,
      i_am_buyer: o.buyer === meLc
    })));
  } catch (e) {
    console.error('GET pending-with error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Подтвердить получение — деньги уходят продавцу. Может только покупатель.
app.post('/api/orders/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const meLc = req.user.username.toLowerCase();
    const order = await one('SELECT * FROM shop_orders WHERE id = ?', req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Заказ уже закрыт' });
    if (order.buyer !== meLc) return res.status(403).json({ error: 'Подтвердить может только покупатель' });

    const msgId = order.id + '_done';
    const ts = Date.now();
    const text = `✅ Заказ «${order.listing_title}» подтверждён — продавцу зачислено ${order.price} 🪙.`;
    let messageRow = null;

    await withTx(async (client) => {
      const upd = await client.query(
        "UPDATE shop_orders SET status = 'completed', completed_at = $1 WHERE id = $2 AND status = 'pending'",
        [ts, order.id]
      );
      if (!upd.rowCount) throw new Error('race');
      await client.query(
        'UPDATE users SET coins = COALESCE(coins, 0) + $1 WHERE LOWER(username) = $2',
        [order.price, order.seller]
      );
      await client.query(
        'INSERT INTO messages (id, sender, receiver, text, created_at) VALUES ($1, $2, $3, $4, $5)',
        [msgId, order.buyer, order.seller, text, ts]
      );
      messageRow = { id: msgId, sender: order.buyer, receiver: order.seller, text, created_at: ts, read_at: null };
    });

    sseSendToUser(order.seller, 'message', { message: messageRow, from: req.user.username });
    sseSendToUser(order.buyer, 'message', { message: messageRow, from: req.user.username });
    sseSendToUser(order.seller, 'order-changed', { peer: req.user.username });
    sseSendToUser(order.buyer, 'order-changed', { peer: order.seller });
    res.json({ ok: true });
  } catch (e) {
    console.error('confirm order error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Отменить заказ — возврат покупателю. Доступно покупателю или продавцу.
app.post('/api/orders/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const meLc = req.user.username.toLowerCase();
    const order = await one('SELECT * FROM shop_orders WHERE id = ?', req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Заказ уже закрыт' });
    if (order.buyer !== meLc && order.seller !== meLc) return res.status(403).json({ error: 'Forbidden' });

    const msgId = order.id + '_cancel';
    const ts = Date.now();
    const by = order.buyer === meLc ? 'покупателем' : 'продавцом';
    const text = `❌ Заказ «${order.listing_title}» отменён ${by} — ${order.price} 🪙 возвращены покупателю.`;
    let messageRow = null;

    await withTx(async (client) => {
      const upd = await client.query(
        "UPDATE shop_orders SET status = 'cancelled', completed_at = $1 WHERE id = $2 AND status = 'pending'",
        [ts, order.id]
      );
      if (!upd.rowCount) throw new Error('race');
      await client.query(
        'UPDATE users SET coins = COALESCE(coins, 0) + $1 WHERE LOWER(username) = $2',
        [order.price, order.buyer]
      );
      await client.query(
        'INSERT INTO messages (id, sender, receiver, text, created_at) VALUES ($1, $2, $3, $4, $5)',
        [msgId, meLc, meLc === order.buyer ? order.seller : order.buyer, text, ts]
      );
      messageRow = {
        id: msgId, sender: meLc,
        receiver: meLc === order.buyer ? order.seller : order.buyer,
        text, created_at: ts, read_at: null
      };
    });

    sseSendToUser(order.seller, 'message', { message: messageRow, from: req.user.username });
    sseSendToUser(order.buyer, 'message', { message: messageRow, from: req.user.username });
    sseSendToUser(order.seller, 'order-changed', { peer: order.buyer });
    sseSendToUser(order.buyer, 'order-changed', { peer: order.seller });
    res.json({ ok: true });
  } catch (e) {
    console.error('cancel order error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/shop/:id', authMiddleware, async (req, res) => {
  const listing = await one('SELECT author, images, banner FROM shop_listings WHERE id = ?', req.params.id);
  if (!listing) return res.status(404).json({ error: 'Not found' });

  const me = await one('SELECT is_admin FROM users WHERE username = ?', req.user.username);
  const isMine = listing.author.toLowerCase() === req.user.username.toLowerCase();
  if (!isMine && !(me && me.is_admin)) return res.status(403).json({ error: 'Forbidden' });

  const unlinkPath = (p) => {
    if (p && p.startsWith('/uploads/')) {
      const fp = path.join(UPLOADS_DIR, path.basename(p));
      fs.promises.unlink(fp).catch(() => {});
    }
  };
  try {
    JSON.parse(listing.images || '[]').forEach(unlinkPath);
  } catch (e) {}
  unlinkPath(listing.banner);

  await run('DELETE FROM shop_listings WHERE id = ?', req.params.id);
  sseBroadcast('delete-listing', { id: req.params.id });
  res.json({ ok: true });
});

// ============ CATEGORIES ============
app.get('/api/categories', async (req, res) => {
  const { kind } = req.query;
  if (kind === 'avatar' || kind === 'wallpaper') {
    const rows = await all("SELECT * FROM categories WHERE COALESCE(kind, 'wallpaper') = ?", kind);
    res.json(rows);
  } else {
    const rows = await all('SELECT * FROM categories');
    res.json(rows);
  }
});

app.post('/api/categories', authMiddleware, async (req, res) => {
  const tag = (req.body.tag || '').toLowerCase().trim();
  const label = (req.body.label || '').trim().slice(0, 50);
  const kind = (req.body.kind === 'avatar') ? 'avatar' : 'wallpaper';
  if (!tag || tag.length < 2) return res.status(400).json({ error: 'Tag too short' });
  if (!/^[a-zа-яё0-9_-]+$/i.test(tag)) return res.status(400).json({ error: 'Bad tag chars' });
  if (!label) return res.status(400).json({ error: 'Label required' });

  try {
    await run('INSERT INTO categories (tag, label, is_custom, kind) VALUES (?, ?, 1, ?)', tag, label, kind);
    res.json({ tag, label, kind });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Already exists' });
    console.error('category insert:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN ============
app.post('/api/admin/promo', authMiddleware, async (req, res) => {
  const code = (req.body.code || '').toLowerCase().trim();
  if (code === 'defyneter') {
    await run('UPDATE users SET is_admin = 1 WHERE username = ?', req.user.username);
    return res.json({ ok: true, message: 'Админка активирована' });
  }
  res.status(404).json({ error: 'Промокод не существует' });
});

app.post('/api/admin/verify/:username', authMiddleware, adminOnly, async (req, res) => {
  await run('UPDATE users SET is_verified = 1 WHERE LOWER(username) = LOWER(?)', req.params.username);
  res.json({ ok: true });
});

app.delete('/api/admin/verify/:username', authMiddleware, adminOnly, async (req, res) => {
  await run('UPDATE users SET is_verified = 0 WHERE LOWER(username) = LOWER(?)', req.params.username);
  res.json({ ok: true });
});

app.post('/api/admin/boost-votes/:postId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { option = 'love', amount = 10 } = req.body || {};
    const n = Math.max(1, Math.min(10000, parseInt(amount, 10)));
    const valid = ['love', 'like', 'meh', 'nope', 'mix'];
    if (!valid.includes(option)) return res.status(400).json({ error: 'Bad option' });

    const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const opts = option === 'mix' ? ['love', 'like', 'meh', 'nope'] : [option];
    await withTx(async (client) => {
      for (let i = 0; i < n; i++) {
        const name = 'boost_' + crypto.randomBytes(5).toString('hex');
        await client.query(
          "INSERT INTO users (username, password_hash, created_at) VALUES ($1, '!boost!', $2) ON CONFLICT (username) DO NOTHING",
          [name, Date.now()]
        );
        const opt = opts[Math.floor(Math.random() * opts.length)];
        await client.query(
          'INSERT INTO votes (post_id, username, option, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (post_id, username) DO NOTHING',
          [req.params.postId, name, opt, Date.now()]
        );
      }
    });
    sseBroadcast('update', await postCounts(req.params.postId));
    res.json({ added: n });
  } catch (e) {
    console.error('boost-votes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/boost-views/:postId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const n = Math.max(1, Math.min(100000, parseInt(req.body.amount, 10) || 100));
    const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    await withTx(async (client) => {
      for (let i = 0; i < n; i++) {
        const name = 'view_' + crypto.randomBytes(6).toString('hex');
        await client.query(
          'INSERT INTO views (post_id, viewer, created_at) VALUES ($1, $2, $3) ON CONFLICT (post_id, viewer) DO NOTHING',
          [req.params.postId, name, Date.now()]
        );
      }
    });
    sseBroadcast('update', await postCounts(req.params.postId));
    res.json({ added: n });
  } catch (e) {
    console.error('boost-views error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/boost-followers/:username', authMiddleware, adminOnly, async (req, res) => {
  try {
    const n = Math.max(1, Math.min(10000, parseInt(req.body.amount, 10) || 50));
    const target = req.params.username.toLowerCase();
    const exists = await one('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)', req.params.username);
    if (!exists) return res.status(404).json({ error: 'User not found' });

    await withTx(async (client) => {
      for (let i = 0; i < n; i++) {
        const name = 'fan_' + crypto.randomBytes(5).toString('hex');
        await client.query(
          "INSERT INTO users (username, password_hash, created_at) VALUES ($1, '!boost!', $2) ON CONFLICT (username) DO NOTHING",
          [name, Date.now()]
        );
        await client.query(
          'INSERT INTO follows (follower, followed, created_at) VALUES ($1, $2, $3) ON CONFLICT (follower, followed) DO NOTHING',
          [name, target, Date.now()]
        );
      }
    });
    res.json({ added: n });
  } catch (e) {
    console.error('boost-followers error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const rows = await all(
    "SELECT username, is_admin, is_verified FROM users WHERE password_hash != '!boost!' ORDER BY username LIMIT 500"
  );
  res.json(rows);
});

app.get('/api/admin/posts', authMiddleware, adminOnly, async (req, res) => {
  const rows = await all('SELECT id, author, title, created_at FROM posts ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

app.delete('/api/admin/posts', authMiddleware, adminOnly, async (req, res) => {
  const allPosts = await all('SELECT image_path FROM posts');
  allPosts.forEach(p => {
    if (p.image_path && p.image_path.startsWith('/uploads/')) {
      const fp = path.join(UPLOADS_DIR, path.basename(p.image_path));
      fs.promises.unlink(fp).catch(() => {});
    }
  });
  await run('DELETE FROM posts');
  await run('DELETE FROM votes');
  await run('DELETE FROM comments');
  await run('DELETE FROM views');
  sseBroadcast('posts-cleared', {});
  res.json({ ok: true });
});

app.post('/api/admin/post-as', authMiddleware, adminOnly, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });

    const asUsername = (req.body.asUsername || '').trim();
    if (!asUsername) return res.status(400).json({ error: 'asUsername required' });

    let targetUser = await one('SELECT username FROM users WHERE LOWER(username) = LOWER(?)', asUsername);
    if (!targetUser) {
      await run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', asUsername, '!admin-created!', Date.now());
      targetUser = { username: asUsername };
    }

    const title = (req.body.title || '').trim().slice(0, 60);
    if (!title) return res.status(400).json({ error: 'Title required' });

    const description = (req.body.description || '').trim().slice(0, 200);
    let categories;
    try { categories = JSON.parse(req.body.categories || '[]'); }
    catch (e) { return res.status(400).json({ error: 'Invalid categories' }); }
    if (!Array.isArray(categories) || categories.length < 3)
      return res.status(400).json({ error: 'Need at least 3 categories' });

    const postType = (req.body.type === 'avatar') ? 'avatar' : 'wallpaper';

    if (postType === 'wallpaper' && isAnimated(req.file.mimetype) && !categories.includes('live')) {
      categories = ['live', ...categories];
    }

    const quality = parseFloat(req.body.quality) || null;
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const imagePath = '/uploads/' + req.file.filename;

    await run(
      `INSERT INTO posts (id, author, title, description, image_path, categories, quality, created_at, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, targetUser.username, title, description, imagePath, JSON.stringify(categories), quality, Date.now(), postType
    );
    sseBroadcast('new-post', { id, type: postType });
    res.json({ id });
  } catch (e) {
    console.error('post-as error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/posts/:id/bots-pause', authMiddleware, adminOnly, async (req, res) => {
  const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  await run('UPDATE posts SET bots_paused = 1 WHERE id = ?', req.params.id);
  res.json({ ok: true, bots_paused: true });
});

app.delete('/api/admin/posts/:id/bots-pause', authMiddleware, adminOnly, async (req, res) => {
  const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  await run('UPDATE posts SET bots_paused = 0 WHERE id = ?', req.params.id);
  res.json({ ok: true, bots_paused: false });
});

app.delete('/api/admin/bot-votes/:postId', authMiddleware, adminOnly, async (req, res) => {
  const post = await one('SELECT 1 FROM posts WHERE id = ?', req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const result = await run(
    'DELETE FROM votes WHERE post_id = ? AND username IN (SELECT username FROM users WHERE is_bot = 1)',
    req.params.postId
  );
  sseBroadcast('update', await postCounts(req.params.postId));
  res.json({ removed: result.changes });
});

// Выдать/отнять монеты юзеру (отрицательное значение = отнять)
app.post('/api/admin/coins/:username', authMiddleware, adminOnly, async (req, res) => {
  try {
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Bad amount' });
    const user = await one('SELECT username FROM users WHERE LOWER(username) = LOWER(?)', req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const r = await pool.query(
      'UPDATE users SET coins = GREATEST(0, COALESCE(coins, 0) + $1) WHERE LOWER(username) = LOWER($2) RETURNING coins',
      [amount, req.params.username]
    );
    res.json({ ok: true, coins: parseInt(r.rows[0].coins, 10) });
  } catch (e) {
    console.error('admin coins error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/self', authMiddleware, adminOnly, async (req, res) => {
  await run('UPDATE users SET is_admin = 0 WHERE username = ?', req.user.username);
  res.json({ ok: true });
});

app.delete('/api/categories/:tag', authMiddleware, async (req, res) => {
  const cat = await one('SELECT * FROM categories WHERE tag = ?', req.params.tag);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (!cat.is_custom) return res.status(403).json({ error: 'Cannot delete built-in' });
  await run('DELETE FROM categories WHERE tag = ?', req.params.tag);
  res.json({ ok: true });
});

// ============ STATIC FRONTEND ============
app.use(express.static(path.join(__dirname, 'public')));

// ============ BOT ENGINE ============
const BOT_NAMES = [
  'masha', 'nikita_k', 'lera', 'denis', 'olga99', 'kostya', 'yulia', 'roma',
  'sasha_m', 'igor', 'milana', 'arseny', 'sofa', 'misha', 'kira_x', 'pavel',
  'anya_b', 'vlad', 'nastya', 'timur', 'dasha', 'lev', 'alina', 'gleb',
  'polina', 'artyom', 'zlata', 'matvey', 'eva_l', 'kirill', 'vera', 'maxim',
  'lika', 'styopa', 'tanya', 'yan', 'mira', 'fedor', 'rita', 'oleg',
  'jane', 'tom_r', 'mike', 'emma', 'leo', 'jess', 'alex', 'sam',
  'ksenia', 'ilya', 'sveta', 'andrey', 'natasha', 'borya', 'galya', 'vova'
];

async function ensureBots() {
  await withTx(async (client) => {
    for (const name of BOT_NAMES) {
      const ago = (30 + Math.floor(Math.random() * 335)) * 24 * 3600 * 1000;
      await client.query(
        "INSERT INTO users (username, password_hash, created_at, is_bot) VALUES ($1, '!bot!', $2, 1) ON CONFLICT (username) DO NOTHING",
        [name, Date.now() - ago]
      );
    }
  });
  console.log(`Bots ready: ${BOT_NAMES.length}`);
}

async function getBots() {
  const rows = await all('SELECT username FROM users WHERE is_bot = 1');
  return rows.map(r => r.username);
}

let botTickRunning = false;
async function botTick() {
  if (botTickRunning) return;
  botTickRunning = true;
  const changedPosts = new Set();
  try {
    const allPosts = await all('SELECT id, quality, created_at FROM posts WHERE bots_paused = 0 ORDER BY created_at DESC LIMIT 200');
    if (!allPosts.length) return;

    const bots = await getBots();
    if (!bots.length) return;

    await withTx(async (client) => {
      for (const post of allPosts) {
        const ageHours = (Date.now() - post.created_at) / 3600000;

        let activity;
        if (ageHours < 1) activity = 1.0;
        else if (ageHours < 6) activity = 0.7;
        else if (ageHours < 24) activity = 0.4;
        else if (ageHours < 72) activity = 0.15;
        else if (ageHours < 168) activity = 0.07;
        else activity = 0.03;

        const viewersThisTick = Math.floor(Math.random() * (activity * 4));
        if (viewersThisTick === 0) continue;

        const selected = [];
        for (let i = 0; i < viewersThisTick; i++) {
          selected.push(bots[Math.floor(Math.random() * bots.length)]);
        }

        for (const botName of selected) {
          const botKey = botName.toLowerCase();
          const r = await client.query(
            'INSERT INTO views (post_id, viewer, created_at) VALUES ($1, $2, $3) ON CONFLICT (post_id, viewer) DO NOTHING',
            [post.id, botKey, Date.now()]
          );
          if (r.rowCount > 0) changedPosts.add(post.id);

          const q = post.quality !== null && post.quality !== undefined ? post.quality : 0.65;
          const voteChance = 0.3 + q * 0.2;
          if (Math.random() < voteChance) {
            const r = Math.random();
            let opt;
            if (q > 0.7) {
              opt = r < 0.4 ? 'love' : r < 0.7 ? 'like' : r < 0.9 ? 'meh' : 'nope';
            } else if (q > 0.4) {
              opt = r < 0.2 ? 'love' : r < 0.55 ? 'like' : r < 0.85 ? 'meh' : 'nope';
            } else {
              opt = r < 0.1 ? 'love' : r < 0.3 ? 'like' : r < 0.65 ? 'meh' : 'nope';
            }
            if (post.quality === null || post.quality === undefined) {
              opt = r < 0.25 ? 'love' : r < 0.55 ? 'like' : r < 0.85 ? 'meh' : 'nope';
            }
            const vr = await client.query(
              'INSERT INTO votes (post_id, username, option, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (post_id, username) DO NOTHING',
              [post.id, botKey, opt, Date.now()]
            );
            if (vr.rowCount > 0) changedPosts.add(post.id);
          }
        }
      }
    });

    if (changedPosts.size && sseClients.size) {
      const updates = await Promise.all([...changedPosts].map(postCounts));
      sseBroadcast('updates', { updates });
    }
  } catch (e) {
    console.error('botTick error:', e);
  } finally {
    botTickRunning = false;
  }
}

// ============ START ============
(async () => {
  try {
    await initDb();
    await ensureBots();
    setInterval(botTick, 30 * 1000);
    app.listen(PORT, () => {
      console.log(`Server on :${PORT}`);
      console.log(`Data: ${DATA_DIR}`);
      console.log(`DB: ${process.env.DATABASE_URL ? 'connected via DATABASE_URL' : 'no DATABASE_URL!'}`);
    });
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
