// 公共逻辑：当前用户切换、API 封装、标签渲染
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function getUserId() {
  return Number(localStorage.getItem('currentUserId') || 1);
}
function setUserId(id) {
  localStorage.setItem('currentUserId', String(id));
}

const USER_STATE_LABELS = {
  not_started: '未完成',
  in_progress: '进行中',
  completed_unclaimed: '已完成·未领取',
  claimed: '已领取',
};
const TASK_STATUS_LABELS = { draft: '草稿', enabled: '已启用', disabled: '已停用' };

function stateTag(state) {
  return `<span class="tag ${state}">${USER_STATE_LABELS[state] || state}</span>`;
}
function taskStatusTag(status) {
  return `<span class="tag ${status}">${TASK_STATUS_LABELS[status] || status}</span>`;
}

async function renderUserSwitch() {
  const box = document.getElementById('user-switch');
  if (!box) return;
  const { users } = await api('/api/users');
  if (!localStorage.getItem('currentUserId')) setUserId(users[0].id);
  const current = getUserId();
  box.innerHTML = `
    <label>当前用户：</label>
    <select id="user-select">
      ${users.map((u) => `<option value="${u.id}" ${u.id === current ? 'selected' : ''}>${u.id}. ${u.username}</option>`).join('')}
    </select>`;
  box.querySelector('select').addEventListener('change', (e) => {
    setUserId(e.target.value);
    location.reload();
  });
}

function fmt(s) { return s || '-'; }

function showMsg(id, text, ok = true) {
  const el = document.getElementById(id);
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

document.addEventListener('DOMContentLoaded', renderUserSwitch);
