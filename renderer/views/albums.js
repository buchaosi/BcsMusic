// 「专辑」视图：展示用户已收藏的专辑（网易云 album_sublist）
// 调用 /api/album/sublist —— 返回 { data: [...] }
async function mountAlbums(container) {
  const api = window.api;
  const ui = window.ui.tracklist;

  container.innerHTML = ui.renderHero({ cover: '', badge: '我的收藏', title: '专辑', meta: '加载中…' });

  try {
    const session = await api.netease.getSession();
    if (!session.cookie || !session.cookie.includes('MUSIC_U=')) {
      container.innerHTML = ui.renderEmpty({
        icon: 'disc-3', title: '登录后查看收藏的专辑',
        hint: '收藏的专辑基于你的网易云账号，请先扫码登录',
      });
      return;
    }
    const data = await api.netease.albumSublist({ limit: 100, offset: 0 }) || [];
    if (!data.length) {
      container.innerHTML = ui.renderEmpty({
        icon: 'disc-3', title: '还没有收藏的专辑',
        hint: '在专辑详情页点击「收藏」按钮即可在此查看',
      });
      return;
    }
    // data: [{ id, name, picUrl, subTime, artists: [{id,name}], ... }]
    const total = data.length;
    const cover = data[0] && (data[0].picUrl || data[0].coverImgUrl);
    const meta = `BcsMusic · 共 ${total} 张已收藏专辑`;
    container.innerHTML = ui.renderHero({ cover, badge: '我的收藏', title: '', meta })
      + `<section class="px-8 pb-8" id="albums-grid-wrap"></section>`;

    const wrap = container.querySelector('#albums-grid-wrap');
    const cards = data.map(a => {
      const c = a.picUrl || a.coverImgUrl || '';
      const artist = (a.artists && a.artists.map(ar => ar.name).join(' / '))
        || (a.artist && a.artist.name) || '';
      const subTime = a.subTime ? new Date(a.subTime).toLocaleDateString() : '';
      return `
        <a href="#/album/${a.id}" class="playlist-card flex flex-col" data-id="${a.id}">
          <div class="aspect-square overflow-hidden ${c ? '' : 'skeleton'}">
            ${c ? `<img src="${c.replace(/http:/, 'https:')}?param=300x300" alt="${ui.escapeHtml(a.name)}" class="w-full h-full object-cover" style="opacity:0;transition:opacity 0.4s ease;" onload="this.style.opacity='1';this.parentElement.classList.remove('skeleton');" onerror="this.parentElement.classList.add('skeleton');this.remove();">` : ''}
          </div>
          <div class="p-3 flex flex-col gap-1">
            <span class="text-sm font-medium truncate" style="color:var(--foreground);">${ui.escapeHtml(a.name)}</span>
            <span class="text-xs truncate" style="color:var(--muted-foreground);">${ui.escapeHtml(artist)}${subTime ? ' · ' + subTime : ''}</span>
          </div>
        </a>
      `;
    }).join('');
    wrap.innerHTML = `<div class="grid gap-4" style="grid-template-columns:repeat(auto-fill, minmax(160px, 1fr));">${cards}</div>`;

    // 逐字标题：等路由动画完成后再出现
    const routeDelay = Math.round(280 * (window.animMult ? window.animMult() : 1));
    const titleEl = container.querySelector('h1');
    if (titleEl) ui.animateTextSwap(titleEl, '', '专辑', { delay: routeDelay });
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
  }
}

window.views = window.views || {};
window.views.albums = { mount: mountAlbums };
