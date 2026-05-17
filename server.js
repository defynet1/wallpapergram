// ============ WALLPAPERS BACKEND ============
// Один файл — весь API. SQLite для хранения, картинки на диске.
// Запуск локально: node server.js
// Деплой: Railway / Amvera — просто залить в репозиторий.

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA_DIR = process.env.DATA_MOUNT_PATH || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

// Создаём папки если их нет
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ============ DATABASE ============
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    avatar TEXT,
    is_admin INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    image_path TEXT NOT NULL,
    categories TEXT NOT NULL,
    quality REAL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (author) REFERENCES users(username) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);

  CREATE TABLE IF NOT EXISTS votes (
    post_id TEXT NOT NULL,
    username TEXT NOT NULL,
    option TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, username),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_votes_post ON votes(post_id);

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

  CREATE TABLE IF NOT EXISTS follows (
    follower TEXT NOT NULL,
    followed TEXT NOT NULL,
    created_at INTEGER NOT NULL,
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
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, viewer),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_views_post ON views(post_id);
`);

// Миграция: добавим колонку is_bot если её нет
try {
  db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER DEFAULT 0');
} catch (e) { /* колонка уже есть */ }

// ============ APP SETUP ============
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

// Multer для загрузки картинок
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
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

// Опциональная авторизация — если есть токен, расшифровываем; нет — гость
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) {}
  }
  next();
}

function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Auth required' });
  const u = db.prepare('SELECT is_admin FROM users WHERE username = ?').get(req.user.username);
  if (!u || !u.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ============ AUTH ROUTES ============
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || username.length < 2 || username.length > 20)
    return res.status(400).json({ error: 'Username 2-20 chars' });
  if (!/^[a-zA-Zа-яА-Я0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Only letters, digits, _' });
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'Password min 4 chars' });

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username taken' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hash, Date.now());

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT username, password_hash FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password' });

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const u = db.prepare(
    'SELECT username, avatar, is_admin, is_verified, created_at FROM users WHERE username = ?'
  ).get(req.user.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// ============ USER ROUTES ============
app.get('/api/users/:username', (req, res) => {
  const u = db.prepare(
    'SELECT username, avatar, is_verified, created_at FROM users WHERE username = ?'
  ).get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });

  const postsCount = db.prepare('SELECT COUNT(*) as c FROM posts WHERE author = ?').get(req.params.username).c;
  const followers = db.prepare('SELECT COUNT(*) as c FROM follows WHERE followed = ?').get(req.params.username.toLowerCase()).c;
  const following = db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower = ?').get(req.params.username.toLowerCase()).c;

  res.json({ ...u, posts: postsCount, followers, following });
});

app.put('/api/me/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET avatar = ? WHERE username = ?').run(url, req.user.username);
  res.json({ avatar: url });
});

// ============ POSTS ============
app.get('/api/posts', optionalAuth, (req, res) => {
  const { search = '', category = '', limit = 50, before } = req.query;

  let sql = `SELECT p.*, u.is_verified as author_verified, u.avatar as author_avatar
             FROM posts p
             LEFT JOIN users u ON u.username = p.author
             WHERE 1=1`;
  const params = [];

  if (before) {
    sql += ' AND p.created_at < ?';
    params.push(parseInt(before, 10));
  }
  if (search) {
    sql += ' AND (p.title LIKE ? OR p.description LIKE ? OR p.author LIKE ? OR p.categories LIKE ?)';
    const like = '%' + search + '%';
    params.push(like, like, like, like);
  }
  if (category) {
    sql += ' AND p.categories LIKE ?';
    params.push('%"' + category + '"%');
  }

  sql += ' ORDER BY p.created_at DESC LIMIT ?';
  params.push(Math.min(parseInt(limit, 10) || 50, 100));

  const rows = db.prepare(sql).all(...params);

  // Подгружаем счётчики голосов и комментариев
  const result = rows.map(p => {
    const votes = db.prepare('SELECT option, COUNT(*) as c FROM votes WHERE post_id = ? GROUP BY option').all(p.id);
    const tally = { love: 0, like: 0, meh: 0, nope: 0 };
    votes.forEach(v => { if (tally[v.option] !== undefined) tally[v.option] = v.c; });

    const commentsCount = db.prepare('SELECT COUNT(*) as c FROM comments WHERE post_id = ?').get(p.id).c;
    const viewsCount = db.prepare('SELECT COUNT(*) as c FROM views WHERE post_id = ?').get(p.id).c;

    let myVote = null;
    if (req.user) {
      const v = db.prepare('SELECT option FROM votes WHERE post_id = ? AND username = ?').get(p.id, req.user.username);
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
  });

  res.json(result);
});

app.post('/api/posts', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image' });

  const title = (req.body.title || '').trim().slice(0, 60);
  if (!title) return res.status(400).json({ error: 'Title required' });

  const description = (req.body.description || '').trim().slice(0, 200);
  let categories;
  try { categories = JSON.parse(req.body.categories || '[]'); }
  catch (e) { return res.status(400).json({ error: 'Invalid categories' }); }
  if (!Array.isArray(categories) || categories.length < 3)
    return res.status(400).json({ error: 'Need at least 3 categories' });

  const quality = parseFloat(req.body.quality) || null;

  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const imagePath = '/uploads/' + req.file.filename;

  db.prepare(`
    INSERT INTO posts (id, author, title, description, image_path, categories, quality, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.username, title, description, imagePath, JSON.stringify(categories), quality, Date.now());

  res.json({ id });
});

app.delete('/api/posts/:id', authMiddleware, (req, res) => {
  const post = db.prepare('SELECT author, image_path FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });

  const me = db.prepare('SELECT is_admin FROM users WHERE username = ?').get(req.user.username);
  const isMine = post.author.toLowerCase() === req.user.username.toLowerCase();
  if (!isMine && !(me && me.is_admin))
    return res.status(403).json({ error: 'Forbidden' });

  // Удаляем файл картинки
  if (post.image_path && post.image_path.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, path.basename(post.image_path));
    fs.promises.unlink(filePath).catch(() => {});
  }

  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Список постов конкретного автора
app.get('/api/users/:username/posts', optionalAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, u.is_verified as author_verified, u.avatar as author_avatar
    FROM posts p LEFT JOIN users u ON u.username = p.author
    WHERE p.author = ? COLLATE NOCASE
    ORDER BY p.created_at DESC LIMIT 100
  `).all(req.params.username);

  const result = rows.map(p => {
    const votes = db.prepare('SELECT option, COUNT(*) as c FROM votes WHERE post_id = ? GROUP BY option').all(p.id);
    const tally = { love: 0, like: 0, meh: 0, nope: 0 };
    votes.forEach(v => { if (tally[v.option] !== undefined) tally[v.option] = v.c; });
    let myVote = null;
    if (req.user) {
      const v = db.prepare('SELECT option FROM votes WHERE post_id = ? AND username = ?').get(p.id, req.user.username);
      myVote = v ? v.option : null;
    }
    return {
      id: p.id, author: p.author, author_avatar: p.author_avatar,
      author_verified: !!p.author_verified, title: p.title,
      description: p.description, image: p.image_path,
      categories: JSON.parse(p.categories || '[]'),
      created_at: p.created_at, votes: tally,
      comments_count: db.prepare('SELECT COUNT(*) as c FROM comments WHERE post_id = ?').get(p.id).c,
      views_count: db.prepare('SELECT COUNT(*) as c FROM views WHERE post_id = ?').get(p.id).c,
      my_vote: myVote
    };
  });
  res.json(result);
});

// ============ VIEWS ============
// Регистрирует просмотр поста текущим пользователем. Один пользователь = один view.
app.post('/api/posts/:id/view', authMiddleware, (req, res) => {
  const post = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  db.prepare(`
    INSERT OR IGNORE INTO views (post_id, viewer, created_at) VALUES (?, ?, ?)
  `).run(req.params.id, req.user.username.toLowerCase(), Date.now());
  res.json({ ok: true });
});

// ============ VOTES ============
app.post('/api/posts/:id/vote', authMiddleware, (req, res) => {
  const { option } = req.body || {};
  const valid = ['love', 'like', 'meh', 'nope'];
  if (!valid.includes(option)) return res.status(400).json({ error: 'Bad option' });

  const post = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  // Upsert — один пользователь = один голос на пост, можно менять
  db.prepare(`
    INSERT INTO votes (post_id, username, option, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id, username) DO UPDATE SET option = excluded.option
  `).run(req.params.id, req.user.username, option, Date.now());

  res.json({ ok: true });
});

app.delete('/api/posts/:id/vote', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM votes WHERE post_id = ? AND username = ?').run(req.params.id, req.user.username);
  res.json({ ok: true });
});

// ============ COMMENTS ============
app.get('/api/posts/:id/comments', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.avatar as author_avatar, u.is_verified as author_verified
    FROM comments c LEFT JOIN users u ON u.username = c.author
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `).all(req.params.id);
  res.json(rows.map(r => ({
    id: r.id, author: r.author, text: r.text, created_at: r.created_at,
    author_avatar: r.author_avatar, author_verified: !!r.author_verified
  })));
});

app.post('/api/posts/:id/comments', authMiddleware, (req, res) => {
  const text = (req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Empty comment' });

  const post = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  db.prepare('INSERT INTO comments (id, post_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, req.user.username, text, Date.now());

  res.json({ id });
});

app.delete('/api/comments/:id', authMiddleware, (req, res) => {
  const c = db.prepare('SELECT c.*, p.author as post_author FROM comments c LEFT JOIN posts p ON p.id = c.post_id WHERE c.id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const me = db.prepare('SELECT is_admin FROM users WHERE username = ?').get(req.user.username);
  const isAuthor = c.author.toLowerCase() === req.user.username.toLowerCase();
  const isPostAuthor = c.post_author && c.post_author.toLowerCase() === req.user.username.toLowerCase();
  if (!isAuthor && !isPostAuthor && !(me && me.is_admin))
    return res.status(403).json({ error: 'Forbidden' });

  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============ FOLLOWS ============
app.post('/api/follow/:username', authMiddleware, (req, res) => {
  const target = req.params.username.toLowerCase();
  const me = req.user.username.toLowerCase();
  if (target === me) return res.status(400).json({ error: 'Cannot follow yourself' });

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(req.params.username);
  if (!exists) return res.status(404).json({ error: 'User not found' });

  db.prepare(`
    INSERT INTO follows (follower, followed, created_at) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(me, target, Date.now());
  res.json({ ok: true });
});

app.delete('/api/follow/:username', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM follows WHERE follower = ? AND followed = ?')
    .run(req.user.username.toLowerCase(), req.params.username.toLowerCase());
  res.json({ ok: true });
});

app.get('/api/follow/check/:username', authMiddleware, (req, res) => {
  const r = db.prepare('SELECT 1 FROM follows WHERE follower = ? AND followed = ?')
    .get(req.user.username.toLowerCase(), req.params.username.toLowerCase());
  res.json({ following: !!r });
});

app.get('/api/users/:username/followers', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, u.avatar, u.is_verified FROM follows f
    JOIN users u ON u.username = f.follower COLLATE NOCASE
    WHERE f.followed = ? ORDER BY f.created_at DESC LIMIT 200
  `).all(req.params.username.toLowerCase());
  res.json(rows);
});

app.get('/api/users/:username/following', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, u.avatar, u.is_verified FROM follows f
    JOIN users u ON u.username = f.followed COLLATE NOCASE
    WHERE f.follower = ? ORDER BY f.created_at DESC LIMIT 200
  `).all(req.params.username.toLowerCase());
  res.json(rows);
});

// ============ CATEGORIES ============
app.get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories').all();
  res.json(rows);
});

app.post('/api/categories', authMiddleware, (req, res) => {
  const tag = (req.body.tag || '').toLowerCase().trim();
  const label = (req.body.label || '').trim().slice(0, 50);
  if (!tag || tag.length < 2) return res.status(400).json({ error: 'Tag too short' });
  if (!/^[a-zа-яё0-9_-]+$/i.test(tag)) return res.status(400).json({ error: 'Bad tag chars' });
  if (!label) return res.status(400).json({ error: 'Label required' });

  try {
    db.prepare('INSERT INTO categories (tag, label, is_custom) VALUES (?, ?, 1)').run(tag, label);
    res.json({ tag, label });
  } catch (e) {
    res.status(409).json({ error: 'Already exists' });
  }
});

// ============ ADMIN ============
app.post('/api/admin/promo', authMiddleware, (req, res) => {
  const code = (req.body.code || '').toLowerCase().trim();
  if (code === 'defyneter') {
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(req.user.username);
    return res.json({ ok: true, message: 'Админка активирована' });
  }
  res.status(404).json({ error: 'Промокод не существует' });
});

app.post('/api/admin/verify/:username', authMiddleware, adminOnly, (req, res) => {
  db.prepare('UPDATE users SET is_verified = 1 WHERE username = ?').run(req.params.username);
  res.json({ ok: true });
});

app.delete('/api/admin/verify/:username', authMiddleware, adminOnly, (req, res) => {
  db.prepare('UPDATE users SET is_verified = 0 WHERE username = ?').run(req.params.username);
  res.json({ ok: true });
});

// Накрутка голосов: создаём фиктивных голосователей "boost_xxx"
app.post('/api/admin/boost-votes/:postId', authMiddleware, adminOnly, (req, res) => {
  const { option = 'love', amount = 10 } = req.body || {};
  const n = Math.max(1, Math.min(10000, parseInt(amount, 10)));
  const valid = ['love', 'like', 'meh', 'nope', 'mix'];
  if (!valid.includes(option)) return res.status(400).json({ error: 'Bad option' });

  const post = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, created_at) VALUES (?, '!boost!', ?)
  `);
  const vote = db.prepare(`
    INSERT OR IGNORE INTO votes (post_id, username, option, created_at) VALUES (?, ?, ?, ?)
  `);

  const opts = option === 'mix' ? ['love', 'like', 'meh', 'nope'] : [option];
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const name = 'boost_' + crypto.randomBytes(5).toString('hex');
      insert.run(name, Date.now());
      const opt = opts[Math.floor(Math.random() * opts.length)];
      vote.run(req.params.postId, name, opt, Date.now());
    }
  });
  tx();
  res.json({ added: n });
});

// Накрутка подписчиков
app.post('/api/admin/boost-followers/:username', authMiddleware, adminOnly, (req, res) => {
  const n = Math.max(1, Math.min(10000, parseInt(req.body.amount, 10) || 50));
  const target = req.params.username.toLowerCase();
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(req.params.username);
  if (!exists) return res.status(404).json({ error: 'User not found' });

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, created_at) VALUES (?, '!boost!', ?)
  `);
  const insertFollow = db.prepare(`
    INSERT OR IGNORE INTO follows (follower, followed, created_at) VALUES (?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const name = 'fan_' + crypto.randomBytes(5).toString('hex');
      insertUser.run(name, Date.now());
      insertFollow.run(name, target, Date.now());
    }
  });
  tx();
  res.json({ added: n });
});

// Список юзеров для админ-панели
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT username, is_admin, is_verified FROM users
    WHERE password_hash != '!boost!' ORDER BY username LIMIT 500`).all();
  res.json(rows);
});

// Список постов для админ-панели (короткий)
app.get('/api/admin/posts', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, author, title, created_at FROM posts ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows);
});

// Удалить ВСЕ посты (админ)
app.delete('/api/admin/posts', authMiddleware, adminOnly, (req, res) => {
  // Сначала удалим файлы картинок
  const allPosts = db.prepare('SELECT image_path FROM posts').all();
  allPosts.forEach(p => {
    if (p.image_path && p.image_path.startsWith('/uploads/')) {
      const fp = path.join(UPLOADS_DIR, path.basename(p.image_path));
      fs.promises.unlink(fp).catch(() => {});
    }
  });
  db.prepare('DELETE FROM posts').run();
  res.json({ ok: true });
});

// Публикация поста от имени другого пользователя
app.post('/api/admin/post-as', authMiddleware, adminOnly, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image' });

  const asUsername = (req.body.asUsername || '').trim();
  if (!asUsername) return res.status(400).json({ error: 'asUsername required' });

  let targetUser = db.prepare('SELECT username FROM users WHERE username = ? COLLATE NOCASE').get(asUsername);
  if (!targetUser) {
    db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(asUsername, '!admin-created!', Date.now());
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

  const quality = parseFloat(req.body.quality) || null;
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const imagePath = '/uploads/' + req.file.filename;

  db.prepare(`
    INSERT INTO posts (id, author, title, description, image_path, categories, quality, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, targetUser.username, title, description, imagePath, JSON.stringify(categories), quality, Date.now());

  res.json({ id });
});

// Снять с себя админку
app.delete('/api/admin/self', authMiddleware, adminOnly, (req, res) => {
  db.prepare('UPDATE users SET is_admin = 0 WHERE username = ?').run(req.user.username);
  res.json({ ok: true });
});

// Удалить кастомную категорию
app.delete('/api/categories/:tag', authMiddleware, (req, res) => {
  // Любой залогиненный может удалить кастомную (если хочешь только админ — поменяй middleware)
  const cat = db.prepare('SELECT * FROM categories WHERE tag = ?').get(req.params.tag);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (!cat.is_custom) return res.status(403).json({ error: 'Cannot delete built-in' });
  db.prepare('DELETE FROM categories WHERE tag = ?').run(req.params.tag);
  res.json({ ok: true });
});

// ============ STATIC FRONTEND ============
// Раздаём фронтенд из ./public — туда положи wallpapers.html (переименуй в index.html)
app.use(express.static(path.join(__dirname, 'public')));

// ============ BOT ENGINE ============
// Боты НЕ создают посты — только голосуют на реальных и добавляют просмотры.
// Это создаёт ощущение активной аудитории для постов реальных пользователей.

const BOT_NAMES = [
  'masha', 'nikita_k', 'lera', 'denis', 'olga99', 'kostya', 'yulia', 'roma',
  'sasha_m', 'igor', 'milana', 'arseny', 'sofa', 'misha', 'kira_x', 'pavel',
  'anya_b', 'vlad', 'nastya', 'timur', 'dasha', 'lev', 'alina', 'gleb',
  'polina', 'artyom', 'zlata', 'matvey', 'eva_l', 'kirill', 'vera', 'maxim',
  'lika', 'styopa', 'tanya', 'yan', 'mira', 'fedor', 'rita', 'oleg',
  'jane', 'tom_r', 'mike', 'emma', 'leo', 'jess', 'alex', 'sam',
  'ksenia', 'ilya', 'sveta', 'andrey', 'natasha', 'borya', 'galya', 'vova'
];

// Создаём бот-юзеров если их ещё нет в БД (один раз при старте)
function ensureBots() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, created_at, is_bot)
    VALUES (?, '!bot!', ?, 1)
  `);
  const tx = db.transaction(() => {
    BOT_NAMES.forEach(name => {
      // Случайная "дата регистрации" — от месяца до года назад
      const ago = (30 + Math.floor(Math.random() * 335)) * 24 * 3600 * 1000;
      insert.run(name, Date.now() - ago);
    });
  });
  tx();
  console.log(`Bots ready: ${BOT_NAMES.length}`);
}

// Получаем список бот-юзеров
function getBots() {
  return db.prepare('SELECT username FROM users WHERE is_bot = 1').all().map(r => r.username);
}

// Один тик активности ботов: ходим по постам, добавляем виды/голоса.
function botTick() {
  try {
    const allPosts = db.prepare('SELECT id, quality, created_at FROM posts ORDER BY created_at DESC LIMIT 200').all();
    if (!allPosts.length) return;

    const bots = getBots();
    if (!bots.length) return;

    const insertView = db.prepare('INSERT OR IGNORE INTO views (post_id, viewer, created_at) VALUES (?, ?, ?)');
    const insertVote = db.prepare(`
      INSERT INTO votes (post_id, username, option, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(post_id, username) DO NOTHING
    `);

    const tx = db.transaction(() => {
      for (const post of allPosts) {
        // Возраст поста в часах
        const ageHours = (Date.now() - post.created_at) / 3600000;

        // Скорость затухания: свежие посты получают больше активности
        // Кривая: новый пост — 1.0, через 24ч — 0.3, через неделю — 0.05
        let activity;
        if (ageHours < 1) activity = 1.0;
        else if (ageHours < 6) activity = 0.7;
        else if (ageHours < 24) activity = 0.4;
        else if (ageHours < 72) activity = 0.15;
        else if (ageHours < 168) activity = 0.07;
        else activity = 0.03;

        // Сколько ботов "посетят" пост за этот тик (раз в 30 сек = ~2 в минуту)
        // На свежем посте — до 3 просмотров за тик, на старом — иногда 0-1.
        const viewersThisTick = Math.floor(Math.random() * (activity * 4));
        if (viewersThisTick === 0) continue;

        // Выбираем случайных ботов
        const selected = [];
        for (let i = 0; i < viewersThisTick; i++) {
          selected.push(bots[Math.floor(Math.random() * bots.length)]);
        }

        for (const botName of selected) {
          const botKey = botName.toLowerCase();
          // Регистрируем просмотр
          insertView.run(post.id, botKey, Date.now());

          // С вероятностью 30-50% бот голосует (зависит от качества)
          const q = post.quality !== null && post.quality !== undefined ? post.quality : 0.65;
          const voteChance = 0.3 + q * 0.2; // 0.3 для плохого, 0.5 для хорошего
          if (Math.random() < voteChance) {
            // Распределение голосов зависит от качества
            // Хорошее качество → больше love/like, плохое → больше meh/nope
            const r = Math.random();
            let opt;
            if (q > 0.7) {
              // Хорошие обои: 40% love, 30% like, 20% meh, 10% nope
              opt = r < 0.4 ? 'love' : r < 0.7 ? 'like' : r < 0.9 ? 'meh' : 'nope';
            } else if (q > 0.4) {
              // Средние: 20% love, 35% like, 30% meh, 15% nope
              opt = r < 0.2 ? 'love' : r < 0.55 ? 'like' : r < 0.85 ? 'meh' : 'nope';
            } else {
              // Плохие: 10% love, 20% like, 35% meh, 35% nope
              opt = r < 0.1 ? 'love' : r < 0.3 ? 'like' : r < 0.65 ? 'meh' : 'nope';
            }
            // Если в данных нет quality (старые посты) — нейтральное распределение
            if (post.quality === null || post.quality === undefined) {
              opt = r < 0.25 ? 'love' : r < 0.55 ? 'like' : r < 0.85 ? 'meh' : 'nope';
            }
            insertVote.run(post.id, botKey, opt, Date.now());
          }
        }
      }
    });
    tx();
  } catch (e) {
    console.error('botTick error:', e);
  }
}

// Запускаем при старте сервера
ensureBots();
setInterval(botTick, 30 * 1000); // каждые 30 секунд

// ============ START ============
app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
});
