// 右键上下文菜单：复用 .context-menu 样式，向下滚动淡入
// 用法：window.ui.contextMenu.show(x, y, items, opts)
// items: [{ type: 'item'|'sep'|'subheader', label, icon, danger, onClick, children }]
//   - type='item'：普通项，点击触发 onClick 后自动关闭菜单
//   - type='sep'：分隔线
//   - type='subheader'：小标题
//   - children: 子菜单项数组（用于「添加到收藏夹」展开收藏夹列表）

const ctxRoot = document.getElementById('context-menu');
let _ctxCloseHandler = null;
let _ctxKeyHandler = null;
// 菜单自身的 click 处理函数 + 当前关联的 flatMap：用命名函数 + 外部变量，避免多次绑定叠加
let _ctxClickHandler = null;
let _ctxFlatMap = null;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// 渲染菜单项 HTML，同时把所有 item 收集到 flatMap（用唯一 key 关联）
function renderItems(items, flatMap, prefix = '') {
  return (items || []).map((it, i) => {
    if (it.type === 'sep') {
      return `<div class="context-menu-separator"></div>`;
    }
    if (it.type === 'subheader') {
      return `<div class="context-menu-subheader">${escapeHtml(it.label || '')}</div>`;
    }
    // 普通项：分配唯一 key（父级前缀 + 本级下标）
    const key = prefix + i;
    flatMap.set(key, it);
    const icon = it.icon ? `<i data-lucide="${escapeHtml(it.icon)}" class="w-4 h-4"></i>` : '';
    const dangerCls = it.danger ? ' danger' : '';
    const hasChildren = it.children && it.children.length;
    const childrenHtml = hasChildren
      ? `<div class="context-menu-playlists hidden" data-children="${key}">${renderItems(it.children, flatMap, key + '-')}</div>`
      : '';
    return `
      <div class="context-menu-item${dangerCls}" data-key="${key}" ${hasChildren ? 'data-expandable="true"' : ''}>
        ${icon}
        <span class="flex-1">${escapeHtml(it.label || '')}</span>
        ${hasChildren ? `<i data-lucide="chevron-right" class="w-3 h-3"></i>` : ''}
      </div>
      ${childrenHtml}
    `;
  }).join('');
}

function show(x, y, items, opts = {}) {
  if (!ctxRoot) return;
  hide(); // 先关掉旧菜单（会清掉旧的 click 监听）

  // 扁平化所有 item（含子项），用唯一 key 关联，避免 data-idx 冲突
  const flatMap = new Map();
  _ctxFlatMap = flatMap;
  ctxRoot.innerHTML = renderItems(items, flatMap);
  ctxRoot.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();

  // 边界处理：超出视窗右下时反向显示
  const rect = ctxRoot.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (left + rect.width > vw - 8) left = vw - rect.width - 8;
  if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
  ctxRoot.style.left = left + 'px';
  ctxRoot.style.top = top + 'px';

  // 绑定点击：用「命名函数 + 全局 _ctxFlatMap」，每次 show 前先移除旧监听再添加新的，避免叠加
  if (_ctxClickHandler) {
    ctxRoot.removeEventListener('click', _ctxClickHandler);
  }
  _ctxClickHandler = (e) => {
    const el = e.target.closest('.context-menu-item');
    if (!el || !_ctxFlatMap) return;
    e.stopPropagation();
    const key = el.dataset.key;
    const item = _ctxFlatMap.get(key);
    if (!item) return;
    // 有子菜单：展开/收起
    if (item.children && item.children.length) {
      const sub = ctxRoot.querySelector(`[data-children="${key}"]`);
      if (sub) {
        const willShow = sub.classList.contains('hidden');
        // 关掉其他已展开的
        ctxRoot.querySelectorAll('.context-menu-playlists').forEach(s => {
          if (s !== sub) s.classList.add('hidden');
        });
        sub.classList.toggle('hidden', !willShow);
      }
      return;
    }
    // 禁用项（加载中占位、加载失败占位）：不执行 onClick 也不自动关闭菜单
    if (item.disabled) {
      e.preventDefault();
      return;
    }
    // 普通项：触发回调后关闭整个菜单
    try { item.onClick && item.onClick(); } catch (err) { console.error('[contextMenu] onClick:', err); }
    hide();
  };
  ctxRoot.addEventListener('click', _ctxClickHandler);

  // 点击外部 / Esc / 滚轮 关闭
  _ctxCloseHandler = (e) => {
    if (e.type === 'click' && ctxRoot.contains(e.target)) return;
    hide();
  };
  document.addEventListener('click', _ctxCloseHandler);
  document.addEventListener('contextmenu', _ctxCloseHandler, true);
  document.addEventListener('wheel', _ctxCloseHandler, true);
  _ctxKeyHandler = (e) => {
    if (e.key === 'Escape') hide();
  };
  document.addEventListener('keydown', _ctxKeyHandler);
}

function hide() {
  if (!ctxRoot) return;
  ctxRoot.classList.add('hidden');
  ctxRoot.innerHTML = '';
  // 移除菜单自身的 click 监听（这才是真正解绑，innerHTML 清空不会移除 addEventListener 绑定的处理）
  if (_ctxClickHandler) {
    ctxRoot.removeEventListener('click', _ctxClickHandler);
    _ctxClickHandler = null;
  }
  _ctxFlatMap = null;
  // 移除全局监听
  if (_ctxCloseHandler) {
    document.removeEventListener('click', _ctxCloseHandler);
    document.removeEventListener('contextmenu', _ctxCloseHandler, true);
    document.removeEventListener('wheel', _ctxCloseHandler, true);
    _ctxCloseHandler = null;
  }
  if (_ctxKeyHandler) {
    document.removeEventListener('keydown', _ctxKeyHandler);
    _ctxKeyHandler = null;
  }
}

// 为歌曲行构建标准菜单：播放此曲 / 下一首播放 / 添加到我喜欢的音乐 / 添加到收藏夹
// track: 单曲对象（网易云格式 { id, name, ar, al, dt }）
// allTracks: 当前列表全部曲目（用于「播放此曲」时把整列表作队列）
async function showForTrack(track, allTracks, x, y, opts = {}) {
  if (!track) return;
  const api = window.api;
  const playlistId = opts.playlistId || null;

  // 检查这首歌是否已喜欢（同步，不等）
  let liked = false;
  if (window.player && window.player.state && window.player.state.likedIds) {
    liked = window.player.state.likedIds.has(String(track.id));
  }

  // ==========================================
  // 修复：先同步弹出初始菜单（"添加到收藏夹"显示加载中），
  // 不要异步拉歌单 -> 等完再 show -> 用户以为没点开 -> 再点触发了旧菜单项
  // ==========================================
  const favChildrenPlaceholder = [{ type: 'item', label: '加载中…', icon: 'loader-2', disabled: true, onClick: () => {} }];

  const makePlaylistChildren = (playlists) => playlists.length
    ? playlists.map(p => ({
        type: 'item', label: p.name || '未命名歌单',
        onClick: async () => {
          try {
            const res = await api.netease.playlistTracks('add', p.id, [track.id]);
            // 网易云 playlist/tracks 接口仅 code: 200 才是成功；code=502/512/其他都是失败
            const ok = res && (res.code === 200);
            if (ok) {
              window.toast(`已添加到「${p.name}」`);
            } else {
              const msg = (res && (res.message || res.msg)) || '';
              window.toast('添加失败' + (msg ? `：${msg}` : '：请稍后重试'));
            }
          } catch (err) {
            window.toast('添加失败：' + (err.message || '请稍后重试'));
          }
        },
      }))
    : [{ type: 'item', label: '（暂无收藏夹，先登录网易云）', onClick: () => {} }];

  const buildItems = (favChildren) => {
    const items = [
      {
        type: 'item', label: '播放此曲', icon: 'play',
        onClick: () => {
          if (window.player && window.player.setQueue) {
            const list = (allTracks && allTracks.length) ? allTracks : [track];
            const idx = list.findIndex(t => t.id === track.id);
            window.player.setQueue(list, idx >= 0 ? idx : 0);
          }
        },
      },
      {
        type: 'item', label: '下一首播放', icon: 'skip-forward',
        onClick: () => {
          if (window.player && window.player.playNext) {
            window.player.playNext(track);
          }
        },
      },
      { type: 'sep' },
      {
        type: 'item', label: liked ? '从我喜欢的音乐移除' : '添加到我喜欢的音乐', icon: 'heart',
        onClick: async () => {
          try {
            await api.netease.like(track.id, !liked);
            if (window.player) {
              if (window.player.state && window.player.state.likedIds) {
                if (!liked) window.player.state.likedIds.add(String(track.id));
                else window.player.state.likedIds.delete(String(track.id));
              }
              if (window.player.current && window.player.current() && window.player.current().id === track.id) {
                window.player.syncLikeButton(track.id);
              }
            }
            window.toast(!liked ? '已添加到我喜欢的音乐' : '已从我喜欢的音乐移除');
          } catch (err) {
            window.toast('操作失败：' + (err.message || '请稍后重试'));
          }
        },
      },
      {
        type: 'item', label: '添加到收藏夹', icon: 'folder-plus',
        children: favChildren,
      },
    ];
    // 在歌单页面：追加「从歌单中删除」选项
    if (playlistId) {
      items.push({ type: 'sep' });
      items.push({
        type: 'item', label: '从歌单中删除', icon: 'trash-2', danger: true,
        onClick: async () => {
          try {
            const res = await api.netease.playlistTracks('del', playlistId, [track.id]);
            if (res && res.code === 200) {
              window.toast('已从歌单中删除');
              // 从 allTracks 里移除并通知视图刷新
              if (allTracks) {
                const i = allTracks.findIndex(t => t.id === track.id);
                if (i >= 0) allTracks.splice(i, 1);
              }
              // 派发自定义事件，视图可监听后重渲染
              window.dispatchEvent(new CustomEvent('playlist:track-removed', { detail: { playlistId, trackId: track.id } }));
            } else {
              const msg = (res && (res.message || res.msg)) || '';
              window.toast('删除失败' + (msg ? `：${msg}` : '：请稍后重试'));
            }
          } catch (err) {
            window.toast('删除失败：' + (err.message || '请稍后重试'));
          }
        },
      });
    }
    return items;
  };
  // 1) 立刻先 show 一次初始菜单（避免异步期间用户无处点击导致误触发旧菜单）
  show(x, y, buildItems(favChildrenPlaceholder));

  // 2) 后台异步拉歌单，拉回来后重新 show（替换掉"加载中"）
  try {
    let playlists = [];
    const session = await api.netease.getSession();
    if (session && session.userId) {
      const body = await api.netease.userPlaylist(session.userId);
      playlists = (body && body.playlist) || body || [];
      if (playlists.length && playlists[0].name === '我喜欢的音乐') {
        playlists = playlists.slice(1);
      }
    }
    show(x, y, buildItems(makePlaylistChildren(playlists)));
  } catch (err) {
    console.warn('[contextMenu] 拉取用户歌单失败:', err);
    show(x, y, buildItems([{ type: 'item', label: '（加载失败，请稍后重试）', disabled: true, onClick: () => {} }]));
  }
}

window.ui = window.ui || {};
window.ui.contextMenu = { show, hide, showForTrack };
