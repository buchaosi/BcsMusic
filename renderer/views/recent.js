// 「最近播放」视图：取网易云 /user/record（type=1 最近一周）
async function mountRecent(container) {
  const api = window.api;
  const ui = window.ui.tracklist;

  container.innerHTML = ui.renderHero({ cover: '', badge: '听歌记录', title: '最近播放', meta: '加载中…' });

  try {
    const session = await api.netease.getSession();
    if (!session.userId) {
      container.innerHTML = ui.renderEmpty({
        icon: 'history', title: '登录后查看最近播放',
      });
      return;
    }
    const records = await api.netease.userRecord(session.userId, 1) || [];
    if (!records.length) {
      container.innerHTML = ui.renderEmpty({ icon: 'history', title: '本周还没有听歌记录' });
      return;
    }
    // records: [{ playCount, score, song: {...} }] —— 把 song 平铺到顶层
    const tracks = records.map(r => r.song || r).filter(Boolean);
    const cover = tracks[0] && tracks[0].al && tracks[0].al.picUrl;
    const meta = `BcsMusic · ${tracks.length} 首 · 本周`;
    container.innerHTML = ui.renderHero({ cover, badge: '听歌记录', title: '', meta, tracks })
      + `<section class="px-8 pb-8" id="tracklist-wrap"></section>`;
    ui.bindPlayAll(container, tracks);
    const tl = ui.renderTracklist(tracks);
    const wrap = container.querySelector('#tracklist-wrap');
    wrap.innerHTML = tl.html;
    tl.bind(wrap);
    // 逐字标题
    const routeDelay = Math.round(280 * (window.animMult ? window.animMult() : 1));
    const titleEl = container.querySelector('h1');
    if (titleEl) ui.animateTextSwap(titleEl, '', '最近播放', { delay: routeDelay });
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
  }
}

window.views = window.views || {};
window.views.recent = { mount: mountRecent };
