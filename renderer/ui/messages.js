// 信息中心：点击顶栏「信息」按钮后下滚出信息列表，点击发送人查看其消息
// - 面板风格与搜索下拉一致（向下滚动 + 淡入）
// - 数据存 localStorage，首次使用播种一条欢迎消息
// - 提供 window.messages.addMessage() 供其他模块推送通知

const MSG_KEY = 'bcsmusic:messages';
// 数据结构：[{ id, sender, senderAvatar, text, time, read }]
// 按发送人分组展示，未读用角标提示

const panel = document.getElementById('messages-panel');
const btn = document.getElementById('btn-messages');
const badge = document.getElementById('msg-badge');

function loadMessages() {
  try {
    const raw = localStorage.getItem(MSG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!list.length) {
      // 首次使用：播种欢迎消息
      const seed = [
        {
          id: Date.now(),
          sender: 'BcsMusic 团队',
          senderAvatar: '',
          text: '欢迎使用 BcsMusic！扫码登录网易云即可同步你的歌单与每日推荐。有任何反馈都可以通过设置页告诉我们。',
          time: Date.now(),
          read: false,
        },
      ];
      localStorage.setItem(MSG_KEY, JSON.stringify(seed));
      return seed;
    }
    return list;
  } catch { return []; }
}

function saveMessages(list) {
  try { localStorage.setItem(MSG_KEY, JSON.stringify(list.slice(-100))); } catch {}
}

function unreadCount() {
  return loadMessages().filter(m => !m.read).length;
}

// 更新角标
function refreshBadge() {
  if (!badge) return;
  const n = unreadCount();
  if (n > 0) { badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }
}

// 按发送人分组：[{ sender, avatar, lastText, lastTime, unread }]
function groupBySender(list) {
  const map = new Map();
  for (const m of list) {
    const key = m.sender || '未知';
    if (!map.has(key)) map.set(key, { sender: key, avatar: m.senderAvatar || '', messages: [], unread: 0, lastTime: 0 });
    const g = map.get(key);
    g.messages.push(m);
    if (!m.read) g.unread++;
    if (m.time > g.lastTime) { g.lastTime = m.time; g.lastText = m.text; }
  }
  return Array.from(map.values()).sort((a, b) => b.lastTime - a.lastTime);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toTimeString().slice(0, 5);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 渲染信息列表（发送人概览）
function renderList() {
  const list = loadMessages();
  const groups = groupBySender(list);
  panel.innerHTML = `
    <div class="mp-header">
      <span class="mp-title">信息中心</span>
      <button class="mp-close" id="mp-close" aria-label="关闭"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="mp-body">
      ${groups.length === 0 ? `<div class="mp-empty">暂无信息</div>` : groups.map(g => `
        <div class="mp-item" data-sender="${escapeHtml(g.sender)}">
          <div class="mp-avatar">${g.avatar
            ? `<img src="${escapeHtml(g.avatar)}" alt="">`
            : `<span>${escapeHtml(g.sender.slice(0, 1))}</span>`}</div>
          <div class="mp-item-text">
            <div class="mp-item-row">
              <span class="mp-item-name">${escapeHtml(g.sender)}</span>
              <span class="mp-item-time">${fmtTime(g.lastTime)}</span>
            </div>
            <div class="mp-item-preview">${escapeHtml((g.lastText || '').slice(0, 40))}</div>
          </div>
          ${g.unread > 0 ? `<span class="mp-unread">${g.unread}</span>` : ''}
        </div>
      `).join('')}
    </div>`;
  if (window.lucide) window.lucide.createIcons();
  panel.querySelector('#mp-close').addEventListener('click', closeMessagesPanel);
  panel.querySelectorAll('.mp-item').forEach(el => {
    el.addEventListener('click', (e) => {
      // 阻止冒泡到 document：否则 renderConversation 替换 innerHTML 后，
      // 点击目标已不在面板内，被外部关闭逻辑误判为「点击外部」而关闭面板
      e.stopPropagation();
      renderConversation(el.dataset.sender);
    });
  });
}

// 渲染某发送人的会话详情
function renderConversation(sender) {
  const list = loadMessages().filter(m => (m.sender || '未知') === sender);
  // 标记已读
  const all = loadMessages();
  all.forEach(m => { if ((m.sender || '未知') === sender) m.read = true; });
  saveMessages(all);
  refreshBadge();

  panel.innerHTML = `
    <div class="mp-header">
      <button class="mp-back" id="mp-back" aria-label="返回"><i data-lucide="arrow-left" class="w-4 h-4"></i></button>
      <span class="mp-title">${escapeHtml(sender)}</span>
      <button class="mp-close" id="mp-close" aria-label="关闭"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="mp-body mp-convo">
      ${list.length === 0 ? `<div class="mp-empty">暂无消息</div>` : list.map(m => `
        <div class="mp-msg">
          <div class="mp-msg-text">${escapeHtml(m.text)}</div>
          <div class="mp-msg-time">${fmtTime(m.time)}</div>
        </div>
      `).join('')}
    </div>`;
  if (window.lucide) window.lucide.createIcons();
  panel.querySelector('#mp-back').addEventListener('click', (e) => { e.stopPropagation(); renderList(); });
  panel.querySelector('#mp-close').addEventListener('click', closeMessagesPanel);
}

function openMessagesPanel() {
  panel.classList.remove('hidden', 'closing');
  // 重新触发动画
  void panel.offsetWidth;
  panel.classList.add('opening');
  setTimeout(() => panel.classList.remove('opening'), 240);
  renderList();
  refreshBadge();
}

function closeMessagesPanel() {
  panel.classList.add('closing');
  setTimeout(() => { panel.classList.add('hidden'); panel.classList.remove('closing'); }, 220);
}

// 绑定按钮
if (btn) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) openMessagesPanel();
    else closeMessagesPanel();
  });
}

// 核心：整个 panel 内的点击都 stopPropagation，避免冒泡到 document
// 修复：会话条目 click 触发 renderConversation → innerHTML 替换 DOM → target 不在 panel 里 → 误判点击面板外而关闭
if (panel) {
  panel.addEventListener('click', (e) => e.stopPropagation());
}

// 点击面板外关闭
document.addEventListener('click', (e) => {
  if (panel.classList.contains('hidden')) return;
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeMessagesPanel();
});

// 公开 API：其他模块可调用推送消息
window.messages = {
  addMessage(sender, text, avatar = '') {
    const list = loadMessages();
    list.push({ id: Date.now() + Math.random(), sender, senderAvatar: avatar, text, time: Date.now(), read: false });
    saveMessages(list);
    refreshBadge();
  },
  refresh: refreshBadge,
};

// 初始化角标
refreshBadge();
