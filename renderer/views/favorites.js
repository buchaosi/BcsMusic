// 「我喜欢的音乐」视图：取用户主歌单（用户歌单列表里 creator===自己 的第一条）
// 注意：本视图复用 player/ui 模块挂在 window 上的 API
async function mountFavorites(container) {
  const api = window.api;
  const ui = window.ui.tracklist;

  container.innerHTML = ui.renderHero({ cover: '', badge: '我喜欢的音乐', title: '我喜欢的音乐', meta: '加载中…' });

  try {
    const session = await api.netease.getSession();
    if (!session.userId) {
      container.innerHTML = ui.renderEmpty({
        icon: 'heart', title: '尚未登录',
        hint: '点击右上角登录网易云音乐，即可看到你喜欢的音乐',
      });
      return;
    }
    const playlists = await api.netease.userPlaylist(session.userId) || [];
    // 「我喜欢的音乐」= 用户创建的第一条歌单（网易云默认会自动建）
    const liked = playlists.find(p => p.creator && String(p.creator.userId) === String(session.userId))
      || playlists[0];
    if (!liked) {
      container.innerHTML = ui.renderEmpty({ icon: 'heart', title: '你还没有「我喜欢的音乐」歌单' });
      return;
    }
    const detail = await api.netease.playlistDetail(liked.id);
    const tracks = (detail && detail.tracks) || [];
    const cover = detail && detail.coverImgUrl;
    const meta = `BcsMusic · ${tracks.length} 首歌曲`;
    container.innerHTML = ui.renderHero({ cover, badge: '', title: '', meta, tracks })
      + `<section class="px-8 pb-8" id="tracklist-wrap"></section>`;
    ui.bindPlayAll(container, tracks);
    const tl = ui.renderTracklist(tracks);
    const wrap = container.querySelector('#tracklist-wrap');
    wrap.innerHTML = tl.html;
    tl.bind(wrap);
    // 逐字标题：等路由动画完成后再出现
    const routeDelay = Math.round(280 * (window.animMult ? window.animMult() : 1));
    const titleEl = container.querySelector('h1');
    if (titleEl) ui.animateTextSwap(titleEl, '', '我喜欢的音乐', { delay: routeDelay });
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
  }
}

window.views = window.views || {};
window.views.favorites = { mount: mountFavorites };
