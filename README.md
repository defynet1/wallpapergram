# Обои · Сервер

Backend для wallpaper-app с реальными пользователями. Express + SQLite + JWT.

## Структура

```
server/
├── server.js          ← весь API
├── package.json
├── data/              ← создаётся автоматически
│   ├── db.sqlite      ← база данных
│   └── uploads/       ← картинки
└── public/
    └── index.html     ← фронтенд (переименованный wallpapers.html)
```

## Запуск локально

```bash
cd server
npm install
node server.js
```

Открой http://localhost:3000 — должен открыться сайт.

## Деплой на Railway

### 1. Создай аккаунт
https://railway.app → войти через GitHub.

### 2. Залей код в GitHub
Создай новый репозиторий, залей туда содержимое папки `server/` (включая `public/index.html`).

### 3. Деплой
- В Railway: **New Project → Deploy from GitHub repo**
- Выбери репозиторий → Deploy
- Railway сам определит Node.js и запустит `npm start`

### 4. Переменные окружения
В настройках проекта (**Variables**) добавь:

| Имя | Значение |
|---|---|
| `JWT_SECRET` | случайная длинная строка, минимум 32 символа |
| `PORT` | Railway проставит сам |

Сгенерировать секрет: `openssl rand -hex 32` или просто набей рандомных букв.

### 5. Постоянное хранилище (важно!)
SQLite и картинки лежат в файлах. По умолчанию Railway даёт **эфемерный** диск — при каждом редеплое всё стирается.

Добавь **Volume**:
- В проекте: **Settings → Volumes → New Volume**
- Mount path: `/data`
- Размер: 1 GB на старте хватит

Сервер автоматически использует `RAILWAY_VOLUME_MOUNT_PATH` и сложит туда `db.sqlite` и `uploads/`.

### 6. Домен
В **Settings → Networking → Generate Domain** — получишь `xxx.up.railway.app`.

Можно подключить свой домен — там же.

## API (краткая шпаргалка)

| Метод | URL | Описание |
|---|---|---|
| POST | `/api/register` | `{username, password}` → `{token}` |
| POST | `/api/login` | `{username, password}` → `{token}` |
| GET | `/api/me` | требует токен |
| GET | `/api/posts?search=&category=` | лента (опц. токен) |
| POST | `/api/posts` | multipart: `image`, `title`, `description`, `categories` (JSON), `quality` |
| DELETE | `/api/posts/:id` | свой пост или админ |
| POST | `/api/posts/:id/vote` | `{option}` |
| DELETE | `/api/posts/:id/vote` | снять голос |
| GET/POST | `/api/posts/:id/comments` | комментарии |
| POST/DELETE | `/api/follow/:username` | подписка |
| PUT | `/api/me/avatar` | multipart `avatar` |
| GET/POST | `/api/categories` | категории |
| POST | `/api/admin/promo` | `{code: "defyneter"}` |
| POST | `/api/admin/verify/:username` | дать галочку |
| POST | `/api/admin/boost-votes/:postId` | накрутить голоса |

## Что НЕ перенесено из localStorage-версии

- **Боты** — на сервере не нужны, теперь будут реальные пользователи
- **Симуляция голосов через AI** — голоса теперь реальные, считаются как обычный COUNT
- **Кривая накопления голосов** — больше не нужна

## Стоимость

- Railway free tier: $5 кредитов/мес, хватает для пет-проекта с ~100 пользователями
- Платный план: $5/мес базовый

## Безопасность (для продакшна)

- [ ] Установить `JWT_SECRET` через переменные окружения, не в коде
- [ ] Rate limiting (express-rate-limit) — защита от спама регистраций и постов
- [ ] HTTPS — Railway даёт автоматически
- [ ] Модерация контента (хотя бы кнопка "пожаловаться")
- [ ] Лимит постов в час на пользователя
