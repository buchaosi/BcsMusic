# bcs-smtc

BcsMusic 的 Windows 原生 SMTC（SystemMediaTransportControls）桥。替代 Chromium 的 `MediaSession→SMTC` 桥，避免 Chromium 把封面下采样到约 150×150 的限制。

## 作用

- 主进程把曲目 metadata / playback state / position 通过 stdin（行式 JSON）发给本子进程
- 本子进程调用 WinRT `SystemMediaTransportControls` API 直接更新 Windows 系统媒体控件
- 封面由主进程下载到临时文件后传本地路径过来，本进程用 `IRandomAccessStreamReference::CreateFromFile` 加载，**尺寸无上限**
- 用户在 SMTC 上点击播放/暂停/上一首/下一首，本子进程通过 stdout（行式 JSON）回传给主进程

## 编译要求

- Rust toolchain（`rustup` 安装 stable）
- Windows SDK（Windows 10+ 自带）
- MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`）

## 构建

```bat
cd smtc-native
cargo build --release
```

产物：`smtc-native/target/release/bcs-smtc.exe`

## 集成

`electron-builder` 会把 `smtc-native/release/bcs-smtc.exe` 打包进安装包（见 `package.json` 的 `extraResources` 配置）。运行时主进程通过 `process.resourcesPath` 定位它并 spawn。

## IPC 协议

行式 JSON（每行一个对象，UTF-8，`\n` 结尾）。

主进程 → 本进程：

```json
{"type":"metadata","title":"...","artist":"...","album":"...","cover_path":"C:\\...\\cover.jpg"}
{"type":"playback","state":"playing|paused|stopped|closed"}
{"type":"position","duration_ms":210000,"position_ms":35000}
{"type":"exit"}
```

本进程 → 主进程：

```json
{"type":"ready"}
{"type":"action","action":"play|pause|next|prev"}
{"type":"error","message":"..."}
```

## 调试

手动测试：

```bat
echo {"\"type\":\"metadata\",\"title\":\"Test\",\"artist\":\"A\",\"album\":\"B\"} | target\release\bcs-smtc.exe
```

子进程会把 `{"type":"ready"}` 写到 stdout，Windows 任务栏音量弹窗里应能看到当前曲目信息。

## 已知限制

- 进度条 seek 操作暂未回传（SMTC 的 `ButtonPressed` 不直接给出 seek 位置；如需支持可监听 `PropertyChanged` 事件中的 `PlaybackPosition`）
- `GetForCurrentView()` 要求线程有窗口，所以本进程必须创建一个隐藏 message-only window
