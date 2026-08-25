// 通用歌单视图：根据 params.id 取网易云 /playlist/detail
// 用于：侧栏「我的歌单」里点击任一歌单、漫游页点击卡片
async function mountPlaylist(container, params) {
  const api = window.api;
  const ui = window.ui.tracklist;
  const id = params && params.id;

  if (!id) {
    container.innerHTML = ui.renderError('缺少歌单 ID');
    return;
  }

  // 占位：骨架封面 + 空标题（逐字动画在路由滚入后触发）
  container.innerHTML = `
    <section class="flex items-end gap-6 px-8 py-8">
      <div class="w-44 h-44 rounded-2xl overflow-hidden shadow-2xl flex-shrink-0 skeleton" id="pl-cover-wrap" style="box-shadow:var(--shadow-2xl);"></div>
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">歌单</span>
        <h1 class="text-3xl font-semibold tracking-tight" id="pl-title" style="color:var(--foreground);"></h1>
        <p class="text-sm max-w-xl" id="pl-meta" style="color:var(--muted-foreground);">正在获取歌单信息…</p>
        <div class="flex items-center gap-3 mt-1" id="pl-actions"></div>
      </div>
    </section>
    <section class="px-8 pb-8" id="tracklist-wrap"></section>
  `;

  const titleEl = container.querySelector('#pl-title');
  const metaEl = container.querySelector('#pl-meta');
  const coverWrap = container.querySelector('#pl-cover-wrap');
  const actionsEl = container.querySelector('#pl-actions');

  try {
    const detail = await api.netease.playlistDetail(id);
    const tracks = (detail && detail.tracks) || [];
    const cover = detail && detail.coverImgUrl;
    const title = (detail && detail.name) || '歌单';
    const creator = detail && detail.creator && detail.creator.nickname;
    const meta = `BcsMusic · ${tracks.length} 首歌曲${creator ? ` · by ${creator}` : ''}`;
    // 标题逐字出现：延迟到路由滚入动画完成后（不阻塞挂载）
    const routeDelay = Math.round(280 * (window.animMult ? window.animMult() : 1));
    ui.animateTextSwap(titleEl, '', title, { delay: routeDelay });
    metaEl.textContent = meta;
    // 封面淡入（替代骨架）
    ui.fadeInCover(coverWrap, cover, '歌单封面');
    // 全部播放按钮（圆角样式，与歌手页/专辑页统一）
    if (tracks.length) {
      actionsEl.innerHTML = `<button class="h-9 px-5 rounded-lg text-sm flex items-center gap-1.5" style="background:var(--primary);color:var(--primary-foreground);" data-action="play-all"><i data-lucide="play" class="w-4 h-4"></i>全部播放</button>`;
      ui.bindPlayAll(container, tracks);
      if (window.lucide) window.lucide.createIcons();
    }
    const tl = ui.renderTracklist(tracks, { playlistId: id });
    const wrap = container.querySelector('#tracklist-wrap');
    wrap.innerHTML = tl.html;
    tl.bind(wrap);
    // 监听「从歌单中删除」事件，重渲染列表
    const onRemoved = (e) => {
      if (e.detail.playlistId !== id) return;
      const remaining = tracks.filter(t => t.id !== e.detail.trackId);
      if (remaining.length === tracks.length) return;
      tracks.length = 0;
      tracks.push(...remaining);
      const tl2 = ui.renderTracklist(tracks, { playlistId: id });
      wrap.innerHTML = tl2.html;
      tl2.bind(wrap);
      // 更新 meta
      if (metaEl) metaEl.textContent = `BcsMusic · ${tracks.length} 首歌曲${creator ? ` · by ${creator}` : ''}`;
    };
    window.addEventListener('playlist:track-removed', onRemoved);
    // 离开页面时清理
    container._cleanup = () => window.removeEventListener('playlist:track-removed', onRemoved);
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
  }
}

window.views = window.views || {};
window.views.playlist = { mount: mountPlaylist };
