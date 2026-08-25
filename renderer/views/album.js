// 专辑详情视图：#/album/:id
// 展示：专辑封面、专辑名、歌曲数量、歌曲列表
// 加载时标题逐字切换 + 封面淡入

// 收藏按钮逻辑：已收藏显示「取消收藏」，未收藏显示「收藏」
async function initAlbumSubButton(container, id, albumInfo) {
  const api = window.api;
  const btn = container.querySelector('#album-sub-btn');
  if (!btn) return;

  // 先看响应里是否直接带 subed 字段
  let subed = (albumInfo && typeof albumInfo.subed === 'boolean') ? albumInfo.subed : null;

  // 响应没带 subed 时，查 sublist 确认
  if (subed === null) {
    try {
      const list = await api.netease.albumSublist({ limit: 100, offset: 0 }) || [];
      subed = list.some(a => String(a.id) === String(id));
    } catch (err) {
      subed = false;
    }
  }

  function renderBtn(isSubed) {
    btn.disabled = false;
    btn.classList.remove('opacity-50');
    btn.innerHTML = isSubed
      ? `<i data-lucide="heart-crack" class="w-4 h-4"></i>取消收藏`
      : `<i data-lucide="heart" class="w-4 h-4"></i>收藏`;
    if (window.lucide) window.lucide.createIcons();
  }
  renderBtn(subed);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>处理中…`;
    if (window.lucide) window.lucide.createIcons();
    const newSubed = !subed;
    try {
      await api.netease.albumSub(id, newSubed ? 1 : 0);
      subed = newSubed;
      renderBtn(subed);
      if (window.toast) window.toast(newSubed ? '已收藏专辑' : '已取消收藏');
    } catch (err) {
      if (window.toast) window.toast('操作失败：' + (err.message || ''));
      renderBtn(subed);
    }
  });
}

async function mountAlbum(container, params) {
  const api = window.api;
  const ui = window.ui.tracklist;
  const id = params && params.id;
  if (!id) {
    container.innerHTML = ui.renderError('缺少专辑 ID');
    return;
  }

  container.innerHTML = `
    <section class="flex items-end gap-6 px-8 py-8">
      <div class="w-44 h-44 rounded-2xl overflow-hidden skeleton flex-shrink-0" id="album-cover-wrap"></div>
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">专辑</span>
        <h1 class="text-3xl font-semibold tracking-tight" id="album-title" style="color:var(--foreground);"></h1>
        <p class="text-sm max-w-xl" id="album-meta" style="color:var(--muted-foreground);">正在获取专辑信息…</p>
        <div class="flex items-center gap-3 mt-1">
          <button id="album-play-all" class="h-9 px-5 rounded-lg text-sm flex items-center gap-1.5" style="background:var(--primary);color:var(--primary-foreground);" disabled>
            <i data-lucide="play" class="w-4 h-4"></i>全部播放
          </button>
          <button id="album-sub-btn" class="h-9 px-4 rounded-lg text-sm flex items-center gap-1.5 opacity-50" disabled style="background:color-mix(in srgb, var(--primary) 10%, transparent); border:1px solid color-mix(in srgb, var(--primary) 30%, transparent); color:var(--primary);">
            <i data-lucide="heart" class="w-4 h-4"></i>收藏
          </button>
        </div>
      </div>
    </section>
    <section class="px-8 pb-8" id="tracklist-wrap"></section>
  `;

  const titleEl = container.querySelector('#album-title');
  const metaEl = container.querySelector('#album-meta');
  const coverWrap = container.querySelector('#album-cover-wrap');
  const listWrap = container.querySelector('#tracklist-wrap');

  let body;
  try {
    body = await api.netease.album(id);
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
    return;
  }
  const albumInfo = (body && body.album) || {};
  const songs = (body && body.songs) || [];
  const name = albumInfo.name || '专辑';
  const cover = albumInfo.picUrl || albumInfo.coverImgUrl || albumInfo.blurPicUrl || '';
  const artist = (albumInfo.artists && albumInfo.artists.map(a => a.name).join(' / '))
    || (albumInfo.artist && albumInfo.artist.name) || '';
  const publishTime = albumInfo.publishTime ? new Date(albumInfo.publishTime).toLocaleDateString() : '';

  // 标题逐字出现：延迟到路由滚入动画完成后（不阻塞挂载）
  const routeDelay = Math.round(280 * (window.animMult ? window.animMult() : 1));
  ui.animateTextSwap(titleEl, '', name, { delay: routeDelay });
  metaEl.textContent = `${artist ? artist + ' · ' : ''}${songs.length} 首歌曲${publishTime ? ' · ' + publishTime : ''}`;

  // 封面淡入
  ui.fadeInCover(coverWrap, cover ? cover.replace(/http:/, 'https:') + '?param=300x300' : '', name);

  // 收藏按钮：检查是否已收藏（albumInfo.subed 优先，否则查 sublist）
  initAlbumSubButton(container, id, albumInfo);

  if (!songs.length) {
    listWrap.innerHTML = ui.renderEmpty({ icon: 'music', title: '专辑暂无歌曲' });
    return;
  }
  ui.bindPlayAll(container, songs);
  // 启用顶部「全部播放」按钮：点击后设置队列并从第一首开始
  const playAllBtn = container.querySelector('#album-play-all');
  if (playAllBtn) {
    playAllBtn.disabled = false;
    playAllBtn.addEventListener('click', () => {
      if (window.player) window.player.setQueue(songs, 0);
    });
  }
  const tl = ui.renderTracklist(songs);
  listWrap.innerHTML = tl.html;
  tl.bind(listWrap);
  if (window.lucide) window.lucide.createIcons();
}

window.views = window.views || {};
window.views.album = { mount: mountAlbum };
