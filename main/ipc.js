// IPC 通道：在主进程里把 NetEase 调用桥接到渲染进程的 window.api.netease.*
const { ipcMain } = require('electron');
const netease = require('./netease');
const { loadSession, saveSession, clearSession } = require('./store');

function registerIpc() {
  // ---------- 登录会话 ----------
  ipcMain.handle('netease:session:get', () => loadSession());

  ipcMain.handle('netease:session:clear', () => {
    clearSession();
    return true;
  });

  ipcMain.handle('netease:qr:key', async () => {
    const body = await netease.qrKey();
    return body && body.data && body.data.unikey; // { unikey, code }
  });

  ipcMain.handle('netease:qr:create', async (_e, key) => {
    const body = await netease.qrCreate(key);
    // body.data: { qrurl, qrimg, code }
    return body && body.data;
  });

  ipcMain.handle('netease:qr:check', async (_e, key) => {
    const body = await netease.qrCheck(key);
    // body: { code, message, cookie }（803=成功）；cookie 是字符串
    if (body && body.code === 803 && body.cookie) {
      saveSession({ ...loadSession(), cookie: body.cookie });
      try {
        const status = await netease.loginStatus();
        const profile = status && status.data && status.data.profile;
        if (profile) {
          saveSession({
            cookie: body.cookie,
            userId: profile.userId,
            nickname: profile.nickname,
            avatarUrl: profile.avatarUrl,
          });
        }
      } catch (err) {
        console.warn('[ipc] 拉取登录态失败:', err.message);
      }
    }
    return body; // { code, message }
  });

  ipcMain.handle('netease:loginStatus', async () => {
    const body = await netease.loginStatus();
    const profile = body && body.data && body.data.profile;
    if (profile) {
      const session = loadSession();
      saveSession({
        ...session,
        userId: profile.userId,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
      });
    }
    return body;
  });

  ipcMain.handle('netease:logout', async () => {
    try { await netease.logout(); } catch {}
    clearSession();
    return true;
  });

  // ---------- 用户内容 ----------
  ipcMain.handle('netease:user:playlist', async (_e, uid) => {
    const body = await netease.userPlaylist(uid);
    return body && body.playlist;
  });

  ipcMain.handle('netease:user:record', async (_e, uid, type = 1) => {
    const body = await netease.userRecord(uid, type);
    return body && (body.weekData || body.allData);
  });

  // ---------- 推荐 ----------
  ipcMain.handle('netease:recommend:songs', async () => {
    const body = await netease.recommendSongs();
    return body && body.data && body.data.dailySongs;
  });

  ipcMain.handle('netease:recommend:resource', async () => {
    const body = await netease.recommendResource();
    return body && body.recommend;
  });

  // ---------- 歌单详情 ----------
  ipcMain.handle('netease:playlist:detail', async (_e, id) => {
    const body = await netease.playlistDetail(id);
    return body && body.playlist;
  });

  // ---------- 歌曲 URL ----------
  ipcMain.handle('netease:song:url', async (_e, id, level = 'exhigh') => {
    const body = await netease.songUrl(id, level);
    const arr = body && body.data;
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  });

  ipcMain.handle('netease:song:urlBatch', async (_e, ids, level = 'exhigh') => {
    const body = await netease.songUrlBatch(ids, level);
    return body && body.data;
  });

  // 智能 URL：试听版自动回退到 MV 音轨
  ipcMain.handle('netease:song:urlSmart', async (_e, id) => {
    return await netease.songUrlSmart(id);
  });

  // ---------- 歌词 ----------
  ipcMain.handle('netease:lyric', async (_e, id) => {
    const body = await netease.lyric(id);
    return body;
  });

  // ---------- 听歌打卡：同步到网易云最近播放 ----------
  ipcMain.handle('netease:scrobble', async (_e, id, sourceId, time) => {
    try {
      return await netease.scrobble(id, sourceId, time);
    } catch (err) {
      // 打卡失败静默忽略，不能影响播放
      console.warn('[ipc] scrobble 失败:', err.message);
      return null;
    }
  });

  // ---------- 喜欢的歌曲 ----------
  ipcMain.handle('netease:like', async (_e, id, like = true) => {
    const body = await netease.likeSong(id, like);
    return body;
  });

  ipcMain.handle('netease:likelist', async (_e, uid) => {
    const ids = await netease.likelist(uid);
    return ids;
  });

  // ---------- 收藏单曲到歌单 / 从歌单删除 ----------
  // op: 'add' | 'del'，pid: 歌单 ID，trackIds: 数组
  ipcMain.handle('netease:playlist:tracks', async (_e, op, pid, trackIds) => {
    try {
      return await netease.playlistTracks(op, pid, trackIds);
    } catch (err) {
      console.warn('[ipc] playlist_tracks 失败:', err.message);
      return null;
    }
  });

  // ---------- 歌手 / 专辑 ----------
  ipcMain.handle('netease:artist:detail', async (_e, id) => {
    return await netease.artistDetail(id);
  });
  ipcMain.handle('netease:artist:topSong', async (_e, id) => {
    return await netease.artistTopSong(id);
  });
  ipcMain.handle('netease:artist:songs', async (_e, id, options) => {
    return await netease.artistSongs(id, options || {});
  });
  ipcMain.handle('netease:artist:album', async (_e, id, options) => {
    const body = await netease.artistAlbum(id, options || {});
    return body && body.hotAlbums;
  });
  ipcMain.handle('netease:artist:mv', async (_e, id, options) => {
    const body = await netease.artistMv(id, options || {});
    return body && body.mvs;
  });
  ipcMain.handle('netease:album', async (_e, id) => {
    return await netease.album(id);
  });
  ipcMain.handle('netease:album:sub', async (_e, id, t) => {
    return await netease.albumSub(id, t);
  });
  ipcMain.handle('netease:album:sublist', async (_e, options) => {
    const body = await netease.albumSublist(options || {});
    return body && body.data;
  });
  ipcMain.handle('netease:artist:sub', async (_e, id, t) => {
    return await netease.artistSub(id, t);
  });
  ipcMain.handle('netease:artist:sublist', async (_e, options) => {
    const body = await netease.artistSublist(options || {});
    return body && body.data;
  });
  ipcMain.handle('netease:personalFm', async () => {
    const body = await netease.personalFm();
    return body && body.data;
  });

  // ---------- MV ----------
  ipcMain.handle('netease:mv:detail', async (_e, id) => {
    return await netease.mvDetail(id);
  });
  ipcMain.handle('netease:mv:url', async (_e, id, r) => {
    return await netease.mvUrl(id, r);
  });

  // ---------- 搜索 ----------
  ipcMain.handle('netease:search', async (_e, keywords, options) => {
    const body = await netease.cloudsearch(keywords, options || {});
    // cloudsearch 返回 { code: 200, result: { songs: [...], songCount: N } }
    // 但某些 NeteaseCloudMusicApi 版本可能直接把 songs/songCount 放在 body 顶层
    if (body && body.result) return body.result;
    return body; // 兜底：直接返回 body（含 songs/songCount）
  });

  ipcMain.handle('netease:search:hot', async () => {
    const body = await netease.searchHotDetail();
    return body && body.data;
  });

  ipcMain.handle('netease:search:suggest', async (_e, keywords) => {
    const body = await netease.searchSuggest(keywords);
    return body && body.result;
  });
}

module.exports = { registerIpc };
