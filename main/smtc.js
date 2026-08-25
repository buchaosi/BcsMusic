// SMTC 原生子进程桥：在主进程里 spawn bcs-smtc.exe，并通过行式 JSON 双向通信
// 用途：替代 Chromium 的 MediaSession→SMTC 桥，让封面尺寸不再被限制到 ~150x150
//
// 路径解析：
//   打包后：process.resourcesPath/bcs-smtc/bcs-smtc.exe（由 electron-builder extraResources 注入）
//   开发时：smtc-native/target/release/bcs-smtc.exe（cargo build --release 产出）

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

// ---------- 解析可执行文件路径 ----------
function resolveExePath() {
  // 打包后（asar 外的 resources 目录）
  try {
    const packaged = path.join(process.resourcesPath, 'bcs-smtc', 'bcs-smtc.exe');
    if (fs.existsSync(packaged)) return packaged;
  } catch (_) {}
  // 开发时
  const dev = path.join(__dirname, '..', 'smtc-native', 'target', 'release', 'bcs-smtc.exe');
  if (fs.existsSync(dev)) return dev;
  return null;
}

// ---------- 下载封面到固定文件，返回绝对路径 ----------
// 关键：所有歌曲共用同一个文件 userData/smtc-cover.jpg
//   - 下载到 .part 临时文件，完成后 rename 覆盖，避免子进程读到半文件
//   - 切歌时新封面覆盖旧封面，磁盘上始终只有 1 个文件，不占空间
//   - 失败返回 null（主进程仍可继续 setMetadata，只是不显示封面）
const { app } = require('electron');
function coverFilePath() {
  return path.join(app.getPath('userData'), 'smtc-cover.jpg');
}
function downloadCover(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const finalPath = coverFilePath();
    const tmpPath = finalPath + '.part';
    const client = url.startsWith('http://') ? http : https;
    const file = fs.createWriteStream(tmpPath);
    const tryGet = (target, redirectsLeft) => {
      const req = client.get(target, (res) => {
        // 处理 3xx 重定向（网易云封面一般不重定向，但为保险）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return tryGet(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          file.close(() => { try { fs.unlink(tmpPath, () => {}); } catch {} });
          return resolve(null);
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            // rename 是原子的：Windows 上同分区 rename 会覆盖目标文件
            try {
              fs.renameSync(tmpPath, finalPath);
              resolve(finalPath);
            } catch (err) {
              try { fs.unlink(tmpPath, () => {}); } catch {}
              resolve(null);
            }
          });
        });
        file.on('error', () => { try { fs.unlink(tmpPath, () => {}); } catch {} resolve(null); });
      });
      req.on('error', () => {
        file.close(() => { try { fs.unlink(tmpPath, () => {}); } catch {} });
        resolve(null);
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    };
    tryGet(url, 3);
  });
}

// ---------- 桥接类 ----------
class SmtcBridge {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.queue = []; // 等 ready 时缓存的命令
    this.onAction = null; // (action: 'play'|'pause'|'next'|'prev') => void
    this.started = false;
  }

  // 启动子进程；找不到 exe 返回 false
  start() {
    if (this.started) return !!this.proc;
    this.started = true;
    const exe = resolveExePath();
    console.log('[smtc] resolveExePath =', exe);
    if (!exe) {
      console.warn('[smtc] 未找到 bcs-smtc.exe（开发：smtc-native/target/release/；打包：resources/bcs-smtc/）。SMTC 将不可用。');
      return false;
    }

    // 解析 icon.ico 路径：传给子进程作为环境变量 BCS_ICON_PATH
    //   子进程创建开始菜单快捷方式时，优先用此 .ico 作为图标
    //   - 开发：项目根/build/icon.ico
    //   - 打包：resources/icon.ico（electron-builder extraFiles 注入，需在 package.json 配置）
    let iconPath = '';
    try {
      const devIcon = path.join(__dirname, '..', 'build', 'icon.ico');
      if (fs.existsSync(devIcon)) iconPath = devIcon;
    } catch {}
    if (!iconPath) {
      try {
        const pkgIcon = path.join(process.resourcesPath, 'icon.ico');
        if (fs.existsSync(pkgIcon)) iconPath = pkgIcon;
      } catch {}
    }
    console.log('[smtc] icon.ico =', iconPath || '(未找到，用 exe 自身图标)');

    try {
      this.proc = spawn(exe, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, BCS_ICON_PATH: iconPath || '' },
      });
      console.log('[smtc] 子进程已 spawn, pid =', this.proc.pid);
    } catch (err) {
      console.error('[smtc] spawn 失败:', err);
      this.proc = null;
      return false;
    }

    // stdout 行式 JSON 解析
    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._handleEvent(line);
      }
    });
    this.proc.stderr.on('data', (d) => process.stderr.write(`[smtc-exe] ${d}`));
    this.proc.on('error', (err) => {
      console.error('[smtc] 子进程错误:', err);
      this.ready = false;
      this.proc = null;
    });
    this.proc.on('exit', (code) => {
      console.warn(`[smtc] 子进程退出 code=${code}`);
      this.ready = false;
      this.proc = null;
    });
    return true;
  }

  _handleEvent(line) {
    let ev;
    try { ev = JSON.parse(line); } catch (_) { return; }
    console.log('[smtc] <- 子进程:', ev.type, ev.action || ev.message || '');
    switch (ev.type) {
      case 'ready':
        this.ready = true;
        console.log('[smtc] 子进程就绪，flush 队列:', this.queue.length, '条');
        for (const cmd of this.queue) this._write(cmd);
        this.queue.length = 0;
        break;
      case 'action':
        if (typeof this.onAction === 'function' && ev.action) {
          try { this.onAction(ev.action); } catch (e) { console.error('[smtc] onAction error:', e); }
        }
        break;
      case 'error':
        console.warn('[smtc] 子进程报错:', ev.message);
        break;
    }
  }

  _write(cmd) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      console.warn('[smtc] _write 跳过: proc=', !!this.proc, 'stdin=', this.proc && !!this.proc.stdin, 'destroyed=', this.proc && this.proc.stdin && this.proc.stdin.destroyed);
      return;
    }
    try {
      const json = JSON.stringify(cmd);
      this.proc.stdin.write(json + '\n');
      console.log('[smtc] -> 子进程:', json.slice(0, 200));
    }
    catch (err) { console.warn('[smtc] 写入失败:', err); }
  }

  _send(cmd) {
    if (!this.proc) return;
    if (this.ready) this._write(cmd);
    else this.queue.push(cmd);
  }

  // 设置曲目 metadata
  // 关键：先立即发一次 metadata（不带封面），让歌曲名/歌手/专辑马上显示；
  //       再异步下载封面，下载成功后补发一次带封面的 metadata。
  //       否则封面下载卡住时，整条 metadata 都发不出去，SMTC 上看不到歌名。
  async setMetadata({ title, artist, album, coverUrl }) {
    console.log('[smtc] setMetadata 调用: title=', JSON.stringify(title), 'artist=', JSON.stringify(artist), 'ready=', this.ready, 'proc=', !!this.proc);
    // 1) 立即发一次（无封面）
    const baseCmd = {
      type: 'metadata',
      title: title || '',
      artist: artist || '',
      album: album || '',
      cover_path: null,
    };
    this._send(baseCmd);

    // 2) 异步下载封面，下载成功后补发一次
    if (!coverUrl) return;
    const currentUrl = coverUrl;
    let coverPath = null;
    try { coverPath = await downloadCover(currentUrl); }
    catch (err) { console.warn('[smtc] 下载封面失败:', err); }
    if (!coverPath) { console.log('[smtc] 封面下载失败，跳过补发'); return; }
    console.log('[smtc] 封面下载成功:', coverPath, '补发带封面的 metadata');

    this._send({
      type: 'metadata',
      title: title || '',
      artist: artist || '',
      album: album || '',
      cover_path: coverPath,
    });
  }

  // 'playing' | 'paused' | 'stopped' | 'closed'
  setPlaybackState(state) {
    this._send({ type: 'playback', state });
  }

  setPositionState(durationMs, positionMs) {
    this._send({
      type: 'position',
      duration_ms: Math.max(0, Math.floor(durationMs || 0)),
      position_ms: Math.max(0, Math.floor(positionMs || 0)),
    });
  }

  stop() {
    if (!this.proc) return;
    try { this._send({ type: 'exit' }); } catch {}
    // 给子进程 200ms 优雅退出，否则强制 kill
    setTimeout(() => {
      if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    }, 200);
  }
}

module.exports = { SmtcBridge, resolveExePath, downloadCover };
