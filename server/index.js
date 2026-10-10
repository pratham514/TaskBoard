require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) console.warn('WARNING: JWT_SECRET not set, using insecure dev secret.');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- helpers ---------- */
const wrap = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (e) { next(e); }
};
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const payload = jwt.verify(h.replace('Bearer ', ''), SECRET);
    const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(payload.id);
    if (!user) return bad(res, 'Account not found', 401);
    req.user = user;
    next();
  } catch {
    bad(res, 'Please sign in again', 401);
  }
}

const isMember = (projectId, userId) =>
  !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);

const isOwner = (projectId, userId) =>
  !!db.prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?').get(projectId, userId);

function notify(userId, actorId, message, projectId, taskId) {
  if (!userId || userId === actorId) return;
  const info = db
    .prepare('INSERT INTO notifications (user_id, message, project_id, task_id) VALUES (?, ?, ?, ?)')
    .run(userId, message, projectId, taskId);
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);
  io.to(`user:${userId}`).emit('notification', n);
}

const broadcast = (projectId, type, extra = {}) =>
  io.to(`project:${projectId}`).emit('project:updated', { projectId, type, ...extra });

function loadTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

/* ---------- auth ---------- */
app.post('/api/auth/register', wrap((req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password) return bad(res, 'Name, email and password are required');
  if (password.length < 6) return bad(res, 'Password must be at least 6 characters');
  const mail = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) return bad(res, 'That email is already registered', 409);
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name.trim(), mail, hash);
  const user = { id: info.lastInsertRowid, name: name.trim(), email: mail };
  res.status(201).json({ token: sign(user), user });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return bad(res, 'Wrong email or password', 401);
  res.json({ token: sign(u), user: publicUser(u) });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

/* ---------- projects ---------- */
app.get('/api/projects', auth, wrap((req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
           (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count
    FROM projects p JOIN project_members pm ON pm.project_id = p.id
    WHERE pm.user_id = ? ORDER BY p.created_at DESC`).all(req.user.id);
  res.json(rows);
}));

app.post('/api/projects', auth, wrap((req, res) => {
  const { name, description } = req.body || {};
  if (!name?.trim()) return bad(res, 'Project name is required');
  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)')
      .run(name.trim(), (description || '').trim(), req.user.id);
    const pid = info.lastInsertRowid;
    db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").run(pid, req.user.id);
    ['To do', 'In progress', 'Done'].forEach((c, i) =>
      db.prepare('INSERT INTO columns (project_id, name, position) VALUES (?, ?, ?)').run(pid, c, i));
    return pid;
  });
  const pid = create();
  io.in(`user:${req.user.id}`).socketsJoin(`project:${pid}`);
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(pid));
}));

app.get('/api/projects/:id', auth, wrap((req, res) => {
  const pid = Number(req.params.id);
  if (!isMember(pid, req.user.id)) return bad(res, 'Project not found', 404);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  const members = db.prepare(`SELECT u.id, u.name, u.email, pm.role FROM project_members pm
    JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name`).all(pid);
  const columns = db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position').all(pid);
  const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ? ORDER BY t.position`).all(pid);
  res.json({ project, members, columns, tasks });
}));

app.delete('/api/projects/:id', auth, wrap((req, res) => {
  const pid = Number(req.params.id);
  if (!isOwner(pid, req.user.id)) return bad(res, 'Only the owner can delete a project', 403);
  db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  broadcast(pid, 'project-deleted');
  res.json({ ok: true });
}));

app.post('/api/projects/:id/members', auth, wrap((req, res) => {
  const pid = Number(req.params.id);
  if (!isOwner(pid, req.user.id)) return bad(res, 'Only the owner can add members', 403);
  const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get((req.body?.email || '').trim().toLowerCase());
  if (!user) return bad(res, 'No user with that email. Ask them to sign up first.', 404);
  if (isMember(pid, user.id)) return bad(res, 'Already a member', 409);
  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')").run(pid, user.id);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(pid);
  io.in(`user:${user.id}`).socketsJoin(`project:${pid}`);
  notify(user.id, req.user.id, `${req.user.name} added you to "${project.name}"`, pid, null);
  broadcast(pid, 'member-added');
  res.status(201).json({ ok: true });
}));

/* ---------- columns ---------- */
app.post('/api/projects/:id/columns', auth, wrap((req, res) => {
  const pid = Number(req.params.id);
  if (!isMember(pid, req.user.id)) return bad(res, 'Project not found', 404);
  if (!req.body?.name?.trim()) return bad(res, 'Column name is required');
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM columns WHERE project_id = ?').get(pid).p;
  const info = db.prepare('INSERT INTO columns (project_id, name, position) VALUES (?, ?, ?)').run(pid, req.body.name.trim(), pos);
  broadcast(pid, 'column-created');
  res.status(201).json({ id: info.lastInsertRowid });
}));

app.delete('/api/columns/:id', auth, wrap((req, res) => {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
  if (!col || !isMember(col.project_id, req.user.id)) return bad(res, 'Column not found', 404);
  db.prepare('DELETE FROM columns WHERE id = ?').run(col.id);
  broadcast(col.project_id, 'column-deleted');
  res.json({ ok: true });
}));

/* ---------- tasks ---------- */
app.post('/api/projects/:id/tasks', auth, wrap((req, res) => {
  const pid = Number(req.params.id);
  if (!isMember(pid, req.user.id)) return bad(res, 'Project not found', 404);
  const { title, column_id, description, assignee_id, due_date } = req.body || {};
  if (!title?.trim()) return bad(res, 'Task title is required');
  const col = db.prepare('SELECT * FROM columns WHERE id = ? AND project_id = ?').get(column_id, pid);
  if (!col) return bad(res, 'Column not found');
  if (assignee_id && !isMember(pid, assignee_id)) return bad(res, 'Assignee must be a project member');
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE column_id = ?').get(col.id).p;
  const info = db.prepare(`INSERT INTO tasks (project_id, column_id, title, description, assignee_id, due_date, position, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(pid, col.id, title.trim(), description || '', assignee_id || null, due_date || null, pos, req.user.id);
  if (assignee_id) notify(assignee_id, req.user.id, `${req.user.name} assigned you "${title.trim()}"`, pid, info.lastInsertRowid);
  broadcast(pid, 'task-created');
  res.status(201).json(loadTask(info.lastInsertRowid));
}));

app.patch('/api/tasks/:id', auth, wrap((req, res) => {
  const task = loadTask(req.params.id);
  if (!task || !isMember(task.project_id, req.user.id)) return bad(res, 'Task not found', 404);
  const b = req.body || {};
  const next = {
    title: b.title !== undefined ? String(b.title).trim() : task.title,
    description: b.description !== undefined ? b.description : task.description,
    due_date: b.due_date !== undefined ? (b.due_date || null) : task.due_date,
    assignee_id: b.assignee_id !== undefined ? (b.assignee_id || null) : task.assignee_id,
  };
  if (!next.title) return bad(res, 'Task title is required');
  if (next.assignee_id && !isMember(task.project_id, next.assignee_id)) return bad(res, 'Assignee must be a project member');

  const update = db.transaction(() => {
    db.prepare('UPDATE tasks SET title = ?, description = ?, due_date = ?, assignee_id = ? WHERE id = ?')
      .run(next.title, next.description, next.due_date, next.assignee_id, task.id);

    // Move / reorder: column_id + position (index within target column)
    if (b.column_id !== undefined || b.position !== undefined) {
      const targetCol = Number(b.column_id ?? task.column_id);
      const col = db.prepare('SELECT 1 FROM columns WHERE id = ? AND project_id = ?').get(targetCol, task.project_id);
      if (!col) throw Object.assign(new Error('Column not found'), { status: 400 });
      const siblings = db.prepare('SELECT id FROM tasks WHERE column_id = ? AND id != ? ORDER BY position')
        .all(targetCol, task.id).map((r) => r.id);
      const idx = Math.max(0, Math.min(Number(b.position ?? siblings.length), siblings.length));
      siblings.splice(idx, 0, task.id);
      const setPos = db.prepare('UPDATE tasks SET column_id = ?, position = ? WHERE id = ?');
      siblings.forEach((id, i) => setPos.run(targetCol, i, id));
    }
  });
  try { update(); } catch (e) { return bad(res, e.message, e.status || 500); }

  if (next.assignee_id && next.assignee_id !== task.assignee_id)
    notify(next.assignee_id, req.user.id, `${req.user.name} assigned you "${next.title}"`, task.project_id, task.id);
  broadcast(task.project_id, 'task-updated', { taskId: task.id });
  res.json(loadTask(task.id));
}));

app.delete('/api/tasks/:id', auth, wrap((req, res) => {
  const task = loadTask(req.params.id);
  if (!task || !isMember(task.project_id, req.user.id)) return bad(res, 'Task not found', 404);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  broadcast(task.project_id, 'task-deleted', { taskId: task.id });
  res.json({ ok: true });
}));

/* ---------- comments ---------- */
app.get('/api/tasks/:id/comments', auth, wrap((req, res) => {
  const task = loadTask(req.params.id);
  if (!task || !isMember(task.project_id, req.user.id)) return bad(res, 'Task not found', 404);
  res.json(db.prepare(`SELECT c.*, u.name AS author FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.created_at, c.id`).all(task.id));
}));

app.post('/api/tasks/:id/comments', auth, wrap((req, res) => {
  const task = loadTask(req.params.id);
  if (!task || !isMember(task.project_id, req.user.id)) return bad(res, 'Task not found', 404);
  const body = (req.body?.body || '').trim();
  if (!body) return bad(res, 'Comment cannot be empty');
  const info = db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(task.id, req.user.id, body);
  const msg = `${req.user.name} commented on "${task.title}"`;
  new Set([task.assignee_id, task.created_by]).forEach((uid) => notify(uid, req.user.id, msg, task.project_id, task.id));
  io.to(`project:${task.project_id}`).emit('comment:new', { projectId: task.project_id, taskId: task.id });
  broadcast(task.project_id, 'comment-added', { taskId: task.id });
  res.status(201).json({ id: info.lastInsertRowid });
}));

/* ---------- notifications ---------- */
app.get('/api/notifications', auth, wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id));
}));

app.post('/api/notifications/read', auth, wrap((req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
}));

/* ---------- errors ---------- */
app.use('/api', (req, res) => bad(res, 'Not found', 404));
app.use((err, req, res, next) => {
  console.error(err);
  bad(res, 'Something went wrong on our side', 500);
});

/* ---------- websockets ---------- */
io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token || '', SECRET);
    socket.userId = payload.id;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
  db.prepare('SELECT project_id FROM project_members WHERE user_id = ?').all(socket.userId)
    .forEach((r) => socket.join(`project:${r.project_id}`));
});

server.listen(PORT, () => console.log(`TaskBoard running at http://localhost:${PORT}`));
