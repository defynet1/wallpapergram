// ============ BACKEND SKELETON ============
// Express + PostgreSQL + JWT-авторизация. Чистый каркас под новое приложение.
// Запуск локально: DATABASE_URL=postgres://... node server.js

const express = require('express');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// BIGINT (OID 20) — парсим как number. Наши значения (timestamps в мс) умещаются в Number.
types.setTypeParser(20, val => val === null ? null : parseInt(val, 10));

const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ============ DATABASE ============
// SSL включаем для облачных БД (Railway даёт DATABASE_URL). Локально можно отключить:
// добавь ?sslmode=disable в DATABASE_URL или задай PGSSL=false.
const dbUrl = process.env.DATABASE_URL;
const useSsl = !!dbUrl && process.env.PGSSL !== 'false' && !/sslmode=disable/i.test(dbUrl);
const pool = new Pool({
  connectionString: dbUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false
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
  // Рейтинг игрока для матчмейкинга (ELO). Ранг вычисляется из него.
  try { await pool.query("ALTER TABLE users ADD COLUMN elo INTEGER DEFAULT 1000"); } catch (e) {}
  // Игровой ник и ID из Standoff 2 — показываются другим игрокам в лобби.
  try { await pool.query("ALTER TABLE users ADD COLUMN game_nick TEXT"); } catch (e) {}
  try { await pool.query("ALTER TABLE users ADD COLUMN game_id TEXT"); } catch (e) {}
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
    const { username, password, gameNick, gameId } = req.body || {};
    if (!username || username.length < 2 || username.length > 20)
      return res.status(400).json({ error: 'Логин 2-20 символов' });
    if (!/^[a-zA-Zа-яА-Я0-9_]+$/.test(username))
      return res.status(400).json({ error: 'Логин: только буквы, цифры, _' });
    if (!password || password.length < 4)
      return res.status(400).json({ error: 'Пароль минимум 4 символа' });

    const gnick = (gameNick || '').trim();
    const gid = (gameId || '').trim();
    if (gnick.length < 2 || gnick.length > 24)
      return res.status(400).json({ error: 'Игровой ник 2-24 символа' });
    if (!/^[0-9]{3,20}$/.test(gid))
      return res.status(400).json({ error: 'Игровой ID — только цифры (3-20)' });

    const exists = await one('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)', username);
    if (exists) return res.status(409).json({ error: 'Логин занят' });

    const hash = await bcrypt.hash(password, 10);
    await run(
      'INSERT INTO users (username, password_hash, created_at, game_nick, game_id) VALUES (?, ?, ?, ?, ?)',
      username, hash, Date.now(), gnick, gid
    );

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
  const u = await one('SELECT username, avatar, is_admin, is_verified, created_at, COALESCE(elo, 1000)::int as elo, game_nick, game_id FROM users WHERE username = ?', req.user.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// ============ USER ROUTES ============
app.get('/api/users/:username', async (req, res) => {
  const u = await one('SELECT username, avatar, is_verified, created_at FROM users WHERE LOWER(username) = LOWER(?)', req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// ============ FACEIT LOBBIES (in-memory, realtime via SSE) ============
// Лобби — эфемерное игровое состояние, живёт в памяти (как и SSE-соединения).
// Каждое изменение пушится участникам событием `lobby`; чат — событием `lobby-chat`.
const MAP_POOL = ['sandstone', 'rust', 'province', 'sakura', 'breeze', 'dune'];
const lobbies = new Map(); // id -> lobby

function rankFromElo(elo) {
  if (elo >= 2300) return { key: 'legend', label: 'Legendary' };
  if (elo >= 2000) return { key: 'master', label: 'Master' };
  if (elo >= 1700) return { key: 'elite',  label: 'Elite' };
  if (elo >= 1400) return { key: 'expert', label: 'Expert' };
  return { key: 'pro', label: 'Pro' };
}

function newId(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

async function playerCard(usernameLc) {
  const u = await one('SELECT username, avatar, COALESCE(elo, 1000)::int as elo, game_nick, game_id FROM users WHERE LOWER(username) = LOWER(?)', usernameLc);
  if (!u) return null;
  const rk = rankFromElo(u.elo);
  return {
    username: u.username, gameNick: u.game_nick || u.username, gameId: u.game_id || '',
    avatar: u.avatar || null, elo: u.elo, rank: rk.key, rankLabel: rk.label, ready: false
  };
}

function emptyLobbySeats() { return { alpha: [null, null, null, null, null], bravo: [null, null, null, null, null] }; }
function lobbyCount(lobby) {
  let n = 0;
  for (const side of ['alpha', 'bravo']) for (const p of lobby.seats[side]) if (p) n++;
  return n;
}
function lobbyMembers(lobby) {
  const out = [];
  for (const side of ['alpha', 'bravo']) for (const p of lobby.seats[side]) if (p) out.push(p.username);
  return out;
}
function captainOf(lobby, side) {
  for (const p of lobby.seats[side]) if (p) return p.username.toLowerCase();
  return null;
}
function orderedMembers(lobby, side) {
  return lobby.seats[side].filter(Boolean); // в порядке мест
}
// Кто из команды банит прямо сейчас. Игроки команды банят по очереди (ротация
// по местам), а команды чередуются. ptr[side] увеличивается, когда команда банит.
function currentPickerCard(lobby) {
  const v = lobby.veto;
  if (!v || v.picked) return null;
  const members = orderedMembers(lobby, v.turn);
  if (!members.length) return null;
  return members[v.ptr[v.turn] % members.length];
}
function findCard(lobby, usernameLc) {
  for (const side of ['alpha', 'bravo']) for (const p of lobby.seats[side])
    if (p && p.username.toLowerCase() === usernameLc) return p;
  return null;
}
function findUserLobby(usernameLc) {
  for (const lobby of lobbies.values()) if (findCard(lobby, usernameLc)) return lobby;
  return null;
}
function removeFromLobby(lobby, usernameLc) {
  for (const side of ['alpha', 'bravo']) for (let i = 0; i < lobby.seats[side].length; i++) {
    const p = lobby.seats[side][i];
    if (p && p.username.toLowerCase() === usernameLc) { lobby.seats[side][i] = null; return true; }
  }
  return false;
}
function recomputeHost(lobby) {
  const m = lobbyMembers(lobby);
  if (m.length) lobby.hostLc = m[0].toLowerCase();
}
function pushSys(lobby, text) {
  lobby.chat.push({ id: newId('m'), sys: true, text, ts: Date.now() });
  if (lobby.chat.length > 120) lobby.chat = lobby.chat.slice(-120);
}

function sanitizeLobby(lobby) {
  const seat = side => lobby.seats[side].map(p => {
    if (!p) return null;
    return {
      username: p.username, gameNick: p.gameNick, gameId: p.gameId,
      avatar: p.avatar, elo: p.elo, rank: p.rank, rankLabel: p.rankLabel,
      ready: p.ready, captain: captainOf(lobby, side) === p.username.toLowerCase()
    };
  });
  const picker = currentPickerCard(lobby);
  return {
    id: lobby.id, name: lobby.name, mode: lobby.mode, phase: lobby.phase, hostLc: lobby.hostLc,
    seats: { alpha: seat('alpha'), bravo: seat('bravo') },
    chat: lobby.chat,
    count: lobbyCount(lobby),
    veto: lobby.veto ? {
      turn: lobby.veto.turn,
      picked: lobby.veto.picked,
      maps: lobby.veto.maps.map(m => ({ id: m.id, banned: m.banned, by: m.by })),
      currentPicker: picker ? picker.username.toLowerCase() : null,
      currentPickerName: picker ? (picker.gameNick || picker.username) : null
    } : null
  };
}
function pushLobby(lobby) {
  const data = sanitizeLobby(lobby);
  for (const u of lobbyMembers(lobby)) sseSendToUser(u, 'lobby', data);
}
function leaveCurrentLobby(meLc) {
  const prev = findUserLobby(meLc);
  if (!prev) return;
  removeFromLobby(prev, meLc);
  if (lobbyCount(prev) === 0) { lobbies.delete(prev.id); }
  else { recomputeHost(prev); pushLobby(prev); }
  sseBroadcast('lobbies', {});
}

// Список открытых лобби (для меню)
app.get('/api/lobbies', (req, res) => {
  const list = [...lobbies.values()]
    .filter(l => lobbyCount(l) > 0)
    .map(l => ({ id: l.id, name: l.name, mode: l.mode, phase: l.phase, count: lobbyCount(l) }));
  res.json(list);
});

// Моё текущее лобби (восстановление после рефреша)
app.get('/api/lobbies/mine', authMiddleware, (req, res) => {
  const lobby = findUserLobby(req.user.username.toLowerCase());
  res.json(lobby ? sanitizeLobby(lobby) : null);
});

// Создать лобби
app.post('/api/lobbies', authMiddleware, async (req, res) => {
  try {
    const meLc = req.user.username.toLowerCase();
    leaveCurrentLobby(meLc);
    const card = await playerCard(meLc);
    if (!card) return res.status(404).json({ error: 'User not found' });

    const name = (req.body.name || '').trim().slice(0, 40) || `Лобби ${card.username}`;
    const mode = ['ranked', 'casual', 'tournament'].includes(req.body.mode) ? req.body.mode : 'ranked';
    const id = newId('L');
    const lobby = {
      id, name, mode, createdAt: Date.now(), hostLc: meLc, phase: 'lobby',
      seats: emptyLobbySeats(), chat: [], veto: null
    };
    lobby.seats.alpha[0] = card;
    pushSys(lobby, `Лобби создано. Капитан Alpha — ${card.username}.`);
    lobbies.set(id, lobby);
    res.json(sanitizeLobby(lobby));
    sseBroadcast('lobbies', {});
  } catch (e) {
    console.error('create lobby error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Зайти в лобби
app.post('/api/lobbies/:id/join', authMiddleware, async (req, res) => {
  try {
    const lobby = lobbies.get(req.params.id);
    if (!lobby) return res.status(404).json({ error: 'Лобби не найдено' });
    const meLc = req.user.username.toLowerCase();
    if (findCard(lobby, meLc)) return res.json(sanitizeLobby(lobby)); // уже внутри
    if (lobby.phase !== 'lobby') return res.status(400).json({ error: 'Матч уже начался' });
    if (lobbyCount(lobby) >= 10) return res.status(400).json({ error: 'Лобби заполнено' });

    leaveCurrentLobby(meLc);
    const card = await playerCard(meLc);
    // Балансируем: садим в команду, где меньше игроков
    const a = lobby.seats.alpha.filter(Boolean).length;
    const b = lobby.seats.bravo.filter(Boolean).length;
    const order = a <= b ? ['alpha', 'bravo'] : ['bravo', 'alpha'];
    let placed = false;
    for (const side of order) {
      const idx = lobby.seats[side].findIndex(p => !p);
      if (idx >= 0) { lobby.seats[side][idx] = card; placed = true; break; }
    }
    if (!placed) return res.status(400).json({ error: 'Лобби заполнено' });

    pushSys(lobby, `${card.username} зашёл в лобби.`);
    res.json(sanitizeLobby(lobby));
    pushLobby(lobby);
    sseBroadcast('lobbies', {});
  } catch (e) {
    console.error('join lobby error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Выйти
app.post('/api/lobbies/:id/leave', authMiddleware, (req, res) => {
  const lobby = lobbies.get(req.params.id);
  if (lobby && findCard(lobby, req.user.username.toLowerCase())) {
    pushSys(lobby, `${req.user.username} вышел из лобби.`);
    leaveCurrentLobby(req.user.username.toLowerCase());
  }
  res.json({ ok: true });
});

// Пересесть на конкретное место
app.post('/api/lobbies/:id/sit', authMiddleware, (req, res) => {
  const lobby = lobbies.get(req.params.id);
  if (!lobby) return res.status(404).json({ error: 'Лобби не найдено' });
  if (lobby.phase !== 'lobby') return res.status(400).json({ error: 'Сейчас нельзя пересаживаться' });
  const { side, idx } = req.body || {};
  if (!['alpha', 'bravo'].includes(side) || !(idx >= 0 && idx < 5)) return res.status(400).json({ error: 'Bad seat' });
  if (lobby.seats[side][idx]) return res.status(400).json({ error: 'Место занято' });

  const meLc = req.user.username.toLowerCase();
  const card = findCard(lobby, meLc);
  if (!card) return res.status(400).json({ error: 'Ты не в этом лобби' });
  removeFromLobby(lobby, meLc);
  lobby.seats[side][idx] = card;
  res.json(sanitizeLobby(lobby));
  pushLobby(lobby);
});

// Готовность
app.post('/api/lobbies/:id/ready', authMiddleware, (req, res) => {
  const lobby = lobbies.get(req.params.id);
  if (!lobby) return res.status(404).json({ error: 'Лобби не найдено' });
  const card = findCard(lobby, req.user.username.toLowerCase());
  if (!card) return res.status(400).json({ error: 'Ты не в этом лобби' });
  card.ready = !card.ready;
  res.json(sanitizeLobby(lobby));
  pushLobby(lobby);
});

// Чат лобби
app.post('/api/lobbies/:id/chat', authMiddleware, (req, res) => {
  const lobby = lobbies.get(req.params.id);
  if (!lobby) return res.status(404).json({ error: 'Лобби не найдено' });
  const meLc = req.user.username.toLowerCase();
  const card = findCard(lobby, meLc);
  if (!card) return res.status(403).json({ error: 'Ты не в этом лобби' });
  const text = (req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'Пусто' });

  const message = { id: newId('m'), user: card.gameNick || req.user.username, text, ts: Date.now() };
  lobby.chat.push(message);
  if (lobby.chat.length > 120) lobby.chat = lobby.chat.slice(-120);
  for (const u of lobbyMembers(lobby)) sseSendToUser(u, 'lobby-chat', { lobbyId: lobby.id, message });
  res.json({ ok: true });
});

// Хост запускает фазу бана карт
app.post('/api/lobbies/:id/start-veto', authMiddleware, (req, res) => {
  const lobby = lobbies.get(req.params.id);
  if (!lobby) return res.status(404).json({ error: 'Лобби не найдено' });
  if (lobby.hostLc !== req.user.username.toLowerCase()) return res.status(403).json({ error: 'Только хост может начать' });
  if (lobby.phase !== 'lobby') return res.status(400).json({ error: 'Уже идёт' });
  if (lobby.seats.alpha.filter(Boolean).length < 1 || lobby.seats.bravo.filter(Boolean).length < 1)
    return res.status(400).json({ error: 'Нужно хотя бы по одному игроку в каждой команде' });

  lobby.phase = 'veto';
  lobby.veto = {
    turn: 'alpha', picked: null,
    ptr: { alpha: 0, bravo: 0 }, // указатель ротации игроков внутри команды
    maps: MAP_POOL.map(id => ({ id, banned: false, by: null }))
  };
  const first = currentPickerCard(lobby);
  pushSys(lobby, `Фаза бана карт началась. Первым банит ${first ? (first.gameNick || first.username) : 'Team Alpha'} (Team Alpha).`);
  res.json(sanitizeLobby(lobby));
  pushLobby(lobby);
  sseBroadcast('lobbies', {});
});

// Бан карты — банит игрок, чья сейчас очередь (ротация по игрокам, команды чередуются)
app.post('/api/lobbies/:id/ban', authMiddleware, (req, res) => {
  const lobby = lobbies.get(req.params.id);
  if (!lobby || lobby.phase !== 'veto' || !lobby.veto) return res.status(400).json({ error: 'Сейчас не фаза бана' });
  const meLc = req.user.username.toLowerCase();
  const turn = lobby.veto.turn;
  const picker = currentPickerCard(lobby);
  if (!picker || picker.username.toLowerCase() !== meLc)
    return res.status(403).json({ error: 'Сейчас не твоя очередь банить' });

  const m = lobby.veto.maps.find(x => x.id === req.body.mapId);
  if (!m) return res.status(400).json({ error: 'Нет такой карты' });
  if (m.banned) return res.status(400).json({ error: 'Карта уже забанена' });

  m.banned = true;
  m.by = turn;
  pushSys(lobby, `${picker.gameNick || picker.username} (${turn === 'alpha' ? 'Team Alpha' : 'Team Bravo'}) забанил ${m.id}.`);

  const left = lobby.veto.maps.filter(x => !x.banned);
  if (left.length === 1) {
    lobby.veto.picked = left[0].id;
    lobby.phase = 'done';
    pushSys(lobby, `Карта матча — ${left[0].id}. Подключайтесь к игре!`);
    sseBroadcast('lobbies', {});
  } else {
    lobby.veto.ptr[turn]++;                             // следующий игрок этой команды — на её следующем ходу
    lobby.veto.turn = turn === 'alpha' ? 'bravo' : 'alpha'; // ход переходит другой команде
  }
  res.json(sanitizeLobby(lobby));
  pushLobby(lobby);
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
