// ============ BACKEND SKELETON ============
// Express + PostgreSQL + JWT-авторизация. Чистый каркас под новое приложение.
// Запуск локально: DATABASE_URL=postgres://... node server.js

const express = require('express');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

// BIGINT (OID 20) — парсим как number. Наши значения (timestamps в мс) умещаются в Number.
types.setTypeParser(20, val => val === null ? null : parseInt(val, 10));

const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

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
      created_at BIGINT NOT NULL
    );
  `);
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

// ============ APP SETUP ============
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

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
    await run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', username, hash, Date.now());

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
  const u = await one('SELECT username, avatar, is_admin, is_verified, created_at FROM users WHERE username = ?', req.user.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// ============ USER ROUTES ============
app.get('/api/users/:username', async (req, res) => {
  const u = await one('SELECT username, avatar, is_verified, created_at FROM users WHERE LOWER(username) = LOWER(?)', req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// ============ ADMIN ============
// Активация админки промокодом. Поменяй код под свой проект.
app.post('/api/admin/promo', authMiddleware, async (req, res) => {
  const code = (req.body.code || '').toLowerCase().trim();
  if (code === 'defyneter') {
    await run('UPDATE users SET is_admin = 1 WHERE username = ?', req.user.username);
    return res.json({ ok: true, message: 'Админка активирована' });
  }
  res.status(404).json({ error: 'Промокод не существует' });
});

app.get('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const rows = await all('SELECT username, is_admin, is_verified, created_at FROM users ORDER BY username LIMIT 500');
  res.json(rows);
});

app.post('/api/admin/verify/:username', authMiddleware, adminOnly, async (req, res) => {
  await run('UPDATE users SET is_verified = 1 WHERE LOWER(username) = LOWER(?)', req.params.username);
  res.json({ ok: true });
});

app.delete('/api/admin/verify/:username', authMiddleware, adminOnly, async (req, res) => {
  await run('UPDATE users SET is_verified = 0 WHERE LOWER(username) = LOWER(?)', req.params.username);
  res.json({ ok: true });
});

app.delete('/api/admin/self', authMiddleware, adminOnly, async (req, res) => {
  await run('UPDATE users SET is_admin = 0 WHERE username = ?', req.user.username);
  res.json({ ok: true });
});

// ============ STATIC FRONTEND ============
app.use(express.static(path.join(__dirname, 'public')));

// ============ START ============
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Server on :${PORT}`);
      console.log(`DB: ${process.env.DATABASE_URL ? 'connected via DATABASE_URL' : 'no DATABASE_URL!'}`);
    });
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
})();
