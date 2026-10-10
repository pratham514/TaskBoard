# TaskBoard

A collaborative project management tool in the spirit of Trello and Asana.

**Features**
- Sign up / sign in (bcrypt-hashed passwords, JWT sessions)
- Create group projects and add teammates by email
- Kanban boards: columns, task cards, drag and drop to move and reorder
- Assign tasks, set due dates, edit details
- Comment threads inside every task
- Real-time updates and notifications over WebSockets (Socket.IO)

**Stack:** Node.js, Express, SQLite (better-sqlite3), Socket.IO, vanilla JS front end (no build step).

## Run it

Requires Node 18 or newer.

```bash
npm install
cp .env.example .env     # then set JWT_SECRET to a long random string
npm start
```

Open http://localhost:3000. To try collaboration, register two users (use a normal window and a private window), create a project with the first, add the second by email, then assign a task or leave a comment and watch the other window update.

## Project layout

```
server/db.js      SQLite schema
server/index.js   REST API, auth, WebSocket events
public/           index.html, style.css, app.js (single-page UI)
```

## API summary

All routes except auth need `Authorization: Bearer <token>`.

| Method | Route | Purpose |
|---|---|---|
| POST | /api/auth/register, /api/auth/login | Create account, sign in |
| GET | /api/me | Current user |
| GET, POST | /api/projects | List / create projects |
| GET, DELETE | /api/projects/:id | Board data / delete (owner only) |
| POST | /api/projects/:id/members | Add member by email (owner only) |
| POST | /api/projects/:id/columns | Add column |
| DELETE | /api/columns/:id | Delete column |
| POST | /api/projects/:id/tasks | Create task |
| PATCH, DELETE | /api/tasks/:id | Update, assign, move (`column_id`, `position`) / delete |
| GET, POST | /api/tasks/:id/comments | List / add comments |
| GET | /api/notifications | Latest notifications |
| POST | /api/notifications/read | Mark all read |

**Socket events (server to client):** `project:updated`, `comment:new`, `notification`. Clients authenticate with their JWT in the handshake and are auto-joined to the rooms of their projects.

## Ideas for extending

Task labels and priorities, file attachments, @mentions, activity log, role-based permissions, PostgreSQL for production, and rate limiting on auth routes.
