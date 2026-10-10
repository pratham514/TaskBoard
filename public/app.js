/* TaskBoard front end: vanilla JS, no build step */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const fmtTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

const state = {
  token: localStorage.getItem('token'),
  me: null,
  projects: [],
  current: null, // { project, members, columns, tasks }
  notifs: [],
  showNotifs: false,
  authMode: 'login',
  openTaskId: null,
  socket: null,
};

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { logout(); throw new Error(data.error || 'Signed out'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

/* ---------- boot ---------- */
async function boot() {
  if (!state.token) return renderAuth();
  try {
    state.me = (await api('/me')).user;
    connectSocket();
    await Promise.all([loadProjects(), loadNotifs()]);
    renderShell();
  } catch { renderAuth(); }
}

function logout() {
  localStorage.removeItem('token');
  state.token = null; state.me = null; state.current = null; state.projects = [];
  state.socket?.disconnect(); state.socket = null;
  renderAuth();
}

/* ---------- realtime ---------- */
function connectSocket() {
  state.socket?.disconnect();
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;
  socket.on('project:updated', async ({ projectId, type }) => {
    await loadProjects();
    if (type === 'project-deleted' && state.current?.project.id === projectId) state.current = null;
    else if (state.current?.project.id === projectId) await loadProject(projectId, true);
    renderShell();
    if (state.openTaskId) {
      if (!state.current?.tasks.find((t) => t.id === state.openTaskId)) closeModal();
    }
  });
  socket.on('comment:new', ({ taskId }) => { if (state.openTaskId === taskId) loadComments(taskId); });
  socket.on('notification', (n) => { state.notifs.unshift(n); toast(n.message); renderShell(); });
}

/* ---------- data ---------- */
async function loadProjects() { state.projects = await api('/projects'); }
async function loadNotifs() { state.notifs = await api('/notifications'); }
async function loadProject(id) { state.current = await api('/projects/' + id); }

/* ---------- auth view ---------- */
function renderAuth() {
  const reg = state.authMode === 'register';
  $('#app').innerHTML = `
    <div class="auth">
      <section class="auth-hero">
        <h1>TaskBoard</h1>
        <p>Plan work with your team on shared boards. Assign cards, talk inside each task, and see changes the moment they happen.</p>
      </section>
      <section class="auth-form">
        <form id="auth-form">
          <h2>${reg ? 'Create your account' : 'Sign in'}</h2>
          ${reg ? '<label for="name">Name</label><input id="name" required autocomplete="name" />' : ''}
          <label for="email">Email</label><input id="email" type="email" required autocomplete="email" />
          <label for="password">Password</label><input id="password" type="password" required minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}" />
          <div class="error" id="auth-err"></div>
          <button class="btn" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
          <p>${reg ? 'Have an account?' : 'New here?'} <button type="button" class="switch" id="switch">${reg ? 'Sign in' : 'Create an account'}</button></p>
        </form>
      </section>
    </div>`;
  $('#switch').onclick = () => { state.authMode = reg ? 'login' : 'register'; renderAuth(); };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = { email: $('#email').value, password: $('#password').value };
      if (reg) body.name = $('#name').value;
      const data = await api('/auth/' + (reg ? 'register' : 'login'), 'POST', body);
      state.token = data.token; state.me = data.user;
      localStorage.setItem('token', data.token);
      connectSocket();
      await Promise.all([loadProjects(), loadNotifs()]);
      renderShell();
    } catch (err) { $('#auth-err').textContent = err.message; }
  };
}

/* ---------- shell ---------- */
function renderShell() {
  const unread = state.notifs.filter((n) => !n.is_read).length;
  const cur = state.current;
  $('#app').innerHTML = `
    <div class="shell">
      <header class="topbar">
        <span class="brand">TaskBoard</span>
        <button class="btn ghost small bell" id="bell" aria-label="Notifications">Notifications${unread ? `<span class="count">${unread}</span>` : ''}</button>
        <span>${esc(state.me.name)}</span>
        <button class="btn ghost small" id="logout">Sign out</button>
      </header>
      <div class="layout">
        <aside class="sidebar">
          <h3>Your projects</h3>
          ${state.projects.map((p) => `
            <button class="proj ${cur?.project.id === p.id ? 'active' : ''}" data-id="${p.id}">
              ${esc(p.name)}<small>${p.task_count} tasks, ${p.member_count} members</small>
            </button>`).join('') || '<p class="empty">No projects yet.</p>'}
          <button class="btn new" id="new-project">New project</button>
        </aside>
        <main class="main">${cur ? boardHtml(cur) : '<div class="empty-state"><h2>Pick a project</h2><p>Select one on the left, or create a new project to start a board.</p></div>'}</main>
      </div>
      ${state.showNotifs ? notifHtml() : ''}
    </div>`;
  $('#logout').onclick = logout;
  $('#bell').onclick = toggleNotifs;
  $('#new-project').onclick = newProjectModal;
  document.querySelectorAll('.proj').forEach((b) => (b.onclick = async () => { await loadProject(b.dataset.id); renderShell(); }));
  if (cur) bindBoard();
  if (state.showNotifs) bindNotifs();
}

/* ---------- notifications ---------- */
function notifHtml() {
  return `<div class="notif-panel" id="notif-panel">${
    state.notifs.length
      ? state.notifs.map((n) => `<div class="n ${n.is_read ? '' : 'unread'}" data-p="${n.project_id || ''}" data-t="${n.task_id || ''}">${esc(n.message)}<small>${fmtTime(n.created_at)}</small></div>`).join('')
      : '<div class="empty">Nothing yet. Assignments and comments will show up here.</div>'
  }</div>`;
}
async function toggleNotifs() {
  state.showNotifs = !state.showNotifs;
  if (!state.showNotifs) { await api('/notifications/read', 'POST'); await loadNotifs(); }
  renderShell();
}
function bindNotifs() {
  document.querySelectorAll('.notif-panel .n').forEach((el) => (el.onclick = async () => {
    const p = Number(el.dataset.p), t = Number(el.dataset.t);
    state.showNotifs = false;
    await api('/notifications/read', 'POST'); await loadNotifs();
    if (p) await loadProject(p);
    renderShell();
    if (t) openTask(t);
  }));
}

/* ---------- board ---------- */
function boardHtml({ project, members, columns, tasks }) {
  const isOwner = project.owner_id === state.me.id;
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="board-head">
      <div><h2>${esc(project.name)}</h2>${project.description ? `<p>${esc(project.description)}</p>` : ''}</div>
      <div class="actions">
        <div class="avatars">${members.map((m) => `<div class="avatar" title="${esc(m.name)}">${esc(initials(m.name))}</div>`).join('')}</div>
        ${isOwner ? '<button class="btn ghost small" id="add-member">Add member</button><button class="btn ghost small" id="del-project">Delete project</button>' : ''}
      </div>
    </div>
    <div class="columns">
      ${columns.map((c) => {
        const list = tasks.filter((t) => t.column_id === c.id);
        return `<section class="column" data-col="${c.id}">
          <div class="col-head"><div>${esc(c.name)}<span>${list.length}</span></div>
            <button class="icon-btn del-col" data-col="${c.id}" title="Delete column" aria-label="Delete column ${esc(c.name)}">&times;</button></div>
          <div class="cards">${list.map((t) => `
            <article class="card" draggable="true" data-id="${t.id}" tabindex="0">
              <div class="title">${esc(t.title)}</div>
              <div class="meta">
                ${t.due_date ? `<span class="due ${t.due_date < today && !/done/i.test(c.name) ? 'late' : ''}">Due ${esc(t.due_date)}</span>` : ''}
                ${t.comment_count ? `<span>${t.comment_count} comments</span>` : ''}
                ${t.assignee_name ? `<div class="avatar" title="${esc(t.assignee_name)}">${esc(initials(t.assignee_name))}</div>` : ''}
              </div>
            </article>`).join('')}</div>
          <form class="add-task" data-col="${c.id}"><input placeholder="Add a task" aria-label="Add a task to ${esc(c.name)}" maxlength="200" /></form>
        </section>`;
      }).join('')}
      <form class="add-col" id="add-col"><input placeholder="Add a column" aria-label="Add a column" maxlength="60" /></form>
    </div>`;
}

function bindBoard() {
  const pid = state.current.project.id;
  $('#add-member') && ($('#add-member').onclick = addMemberModal);
  $('#del-project') && ($('#del-project').onclick = async () => {
    if (!confirm('Delete this project and all its tasks?')) return;
    try { await api('/projects/' + pid, 'DELETE'); } catch (e) { toast(e.message); }
  });
  $('#add-col').onsubmit = async (e) => {
    e.preventDefault();
    const v = e.target.querySelector('input').value.trim();
    if (!v) return;
    try { await api(`/projects/${pid}/columns`, 'POST', { name: v }); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('.del-col').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this column and its tasks?')) return;
    try { await api('/columns/' + b.dataset.col, 'DELETE'); } catch (e) { toast(e.message); }
  }));
  document.querySelectorAll('.add-task').forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const input = f.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    try { await api(`/projects/${pid}/tasks`, 'POST', { title, column_id: Number(f.dataset.col) }); } catch (err) { toast(err.message); }
  }));

  // card click + keyboard
  document.querySelectorAll('.card').forEach((c) => {
    c.onclick = () => openTask(Number(c.dataset.id));
    c.onkeydown = (e) => { if (e.key === 'Enter') openTask(Number(c.dataset.id)); };
    c.ondragstart = (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); };
    c.ondragend = () => c.classList.remove('dragging');
  });

  // drag & drop targets
  document.querySelectorAll('.column').forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const taskId = Number(e.dataTransfer.getData('text/plain'));
      if (!taskId) return;
      const others = [...col.querySelectorAll('.card')].filter((c) => Number(c.dataset.id) !== taskId);
      let index = others.length;
      for (let i = 0; i < others.length; i++) {
        const r = others[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { index = i; break; }
      }
      try { await api('/tasks/' + taskId, 'PATCH', { column_id: Number(col.dataset.col), position: index }); }
      catch (err) { toast(err.message); }
    };
  });
}

/* ---------- modals ---------- */
function showModal(html, wide) {
  closeModal();
  const o = document.createElement('div');
  o.className = 'overlay'; o.id = 'overlay';
  o.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  o.onclick = (e) => { if (e.target === o) closeModal(); };
  document.body.appendChild(o);
  return o;
}
function closeModal() { $('#overlay')?.remove(); state.openTaskId = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function newProjectModal() {
  const o = showModal(`
    <h3>New project</h3>
    <form id="np">
      <label for="pn">Name</label><input id="pn" required maxlength="80" />
      <label for="pd">Description (optional)</label><textarea id="pd" maxlength="300"></textarea>
      <div class="error" id="np-err"></div>
      <div class="modal-actions"><button class="btn" type="submit">Create project</button><button class="btn ghost" type="button" id="cancel">Cancel</button></div>
    </form>`);
  $('#cancel', o).onclick = closeModal;
  $('#pn', o).focus();
  $('#np', o).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const p = await api('/projects', 'POST', { name: $('#pn').value, description: $('#pd').value });
      closeModal();
      await loadProjects(); await loadProject(p.id); renderShell();
    } catch (err) { $('#np-err').textContent = err.message; }
  };
}

function addMemberModal() {
  const o = showModal(`
    <h3>Add a member</h3>
    <form id="am">
      <label for="me">Email of a registered user</label><input id="me" type="email" required />
      <div class="error" id="am-err"></div>
      <div class="modal-actions"><button class="btn" type="submit">Add member</button><button class="btn ghost" type="button" id="cancel">Cancel</button></div>
    </form>`);
  $('#cancel', o).onclick = closeModal;
  $('#me', o).focus();
  $('#am', o).onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/projects/${state.current.project.id}/members`, 'POST', { email: $('#me').value }); closeModal(); toast('Member added'); }
    catch (err) { $('#am-err').textContent = err.message; }
  };
}

function openTask(id) {
  const t = state.current?.tasks.find((x) => x.id === id);
  if (!t) return;
  const { members, columns } = state.current;
  const o = showModal(`
    <h3>Task details</h3>
    <form id="tf">
      <label for="tt">Title</label><input id="tt" required maxlength="200" value="${esc(t.title)}" />
      <label for="td">Description</label><textarea id="td">${esc(t.description)}</textarea>
      <div class="row">
        <div><label for="ta">Assigned to</label>
          <select id="ta"><option value="">Unassigned</option>${members.map((m) => `<option value="${m.id}" ${m.id === t.assignee_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
        <div><label for="tdue">Due date</label><input id="tdue" type="date" value="${esc(t.due_date || '')}" /></div>
      </div>
      <label for="tc">Column</label>
      <select id="tc">${columns.map((c) => `<option value="${c.id}" ${c.id === t.column_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <div class="error" id="tf-err"></div>
      <div class="modal-actions">
        <button class="btn" type="submit">Save changes</button>
        <button class="btn ghost" type="button" id="cancel">Close</button>
        <button class="btn danger spacer" type="button" id="del">Delete task</button>
      </div>
    </form>
    <section class="comments">
      <h3>Comments</h3>
      <div id="clist"><p class="empty">Loading comments</p></div>
      <form class="comment-form" id="cf">
        <textarea id="cb" placeholder="Write a comment" aria-label="Write a comment"></textarea>
        <button class="btn" type="submit">Post comment</button>
      </form>
    </section>`, true);
  state.openTaskId = id;
  $('#cancel', o).onclick = closeModal;
  $('#tf', o).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const colChanged = Number($('#tc').value) !== t.column_id;
      const body = { title: $('#tt').value, description: $('#td').value, due_date: $('#tdue').value, assignee_id: $('#ta').value ? Number($('#ta').value) : null };
      if (colChanged) { body.column_id = Number($('#tc').value); body.position = 1e9; }
      await api('/tasks/' + id, 'PATCH', body);
      closeModal();
    } catch (err) { $('#tf-err').textContent = err.message; }
  };
  $('#del', o).onclick = async () => {
    if (!confirm('Delete this task?')) return;
    try { await api('/tasks/' + id, 'DELETE'); closeModal(); } catch (err) { $('#tf-err').textContent = err.message; }
  };
  $('#cf', o).onsubmit = async (e) => {
    e.preventDefault();
    const v = $('#cb').value.trim();
    if (!v) return;
    try { await api(`/tasks/${id}/comments`, 'POST', { body: v }); $('#cb').value = ''; } catch (err) { toast(err.message); }
  };
  loadComments(id);
}

async function loadComments(id) {
  try {
    const list = await api(`/tasks/${id}/comments`);
    const box = $('#clist');
    if (!box) return;
    box.innerHTML = list.length
      ? list.map((c) => `<div class="comment"><b>${esc(c.author)}</b><small>${fmtTime(c.created_at)}</small><p>${esc(c.body)}</p></div>`).join('')
      : '<p class="empty">No comments yet. Start the conversation below.</p>';
    box.scrollTop = box.scrollHeight;
  } catch (e) { toast(e.message); }
}

boot();
