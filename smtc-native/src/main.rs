// BcsMusic 原生 SMTC 桥（仅 Windows）
// ---------------------------------------------------------------
// 作用：替代 Chromium 的 MediaSession→SMTC 桥，避开 Chromium 把封面下采样到
//       约 150×150 的限制。封面由 Electron 主进程下载到临时文件后传路径过来，
//       本进程用 IRandomAccessStreamReference::CreateFromFile 加载，尺寸无上限。
//
// 通信协议：行式 JSON（每行一个 JSON 对象，UTF-8 编码，以 \n 结尾）
//   主进程 → 本进程：
//     {"type":"metadata","title":"...","artist":"...","album":"...","cover_path":"C:\\...\\cover.jpg"}
//     {"type":"playback","state":"playing|paused|stopped|closed"}
//     {"type":"position","duration_ms":210000,"position_ms":35000}
//     {"type":"exit"}
//   本进程 → 主进程：
//     {"type":"ready"}
//     {"type":"action","action":"play|pause|next|prev"}
//
// 关键限制：SystemMediaTransportControls::GetForCurrentView() 要求当前线程有窗口，
//           所以本进程必须创建一个隐藏的 message-only window，并在其线程上初始化 SMTC。

#![windows_subsystem = "windows"]

// OsStringExt 提供 from_wide（从 UTF-16 切片构造 OsString），仅 Windows 可用
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStringExt;

use std::io::{self, BufRead, Write};
use std::sync::mpsc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::Win32::System::WinRT::{RoGetActivationFactory, RoInitialize, RO_INIT_SINGLETHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Environment::GetEnvironmentVariableW;
use windows::Win32::System::Com::{
    CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER,
};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::UI::Shell::{
    SetCurrentProcessExplicitAppUserModelID,
    IShellLinkW, ShellLink,
    SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Media::{
    MediaPlaybackType, MediaPlaybackStatus,
    SystemMediaTransportControls,
    SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
    SystemMediaTransportControlsDisplayUpdater,
    MusicDisplayProperties,
};
use windows::Storage::StorageFile;
use windows::Storage::Streams::RandomAccessStreamReference;
use windows::Foundation::{TimeSpan, TypedEventHandler};

// ---------- IPC 消息定义 ----------
#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
enum Cmd {
    #[serde(rename = "metadata")]
    Metadata {
        title: String,
        artist: String,
        album: String,
        cover_path: Option<String>,
    },
    #[serde(rename = "playback")]
    Playback { state: String },
    #[serde(rename = "position")]
    Position { duration_ms: i64, position_ms: i64 },
    #[serde(rename = "exit")]
    Exit,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Event {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "action")]
    Action { action: &'static str },
    #[serde(rename = "error")]
    Error { message: String },
}

// ---------- 全局退出标志 ----------
static SHOULD_EXIT: AtomicBool = AtomicBool::new(false);

// 强制刷新 stderr —— 崩溃前必须 flush，否则日志丢失
fn flush_stderr() {
    use std::io::Write;
    let _ = std::io::stderr().flush();
}

// 带自动 flush 的 eprintln 宏
macro_rules! elog {
    ($($arg:tt)*) => {{
        eprintln!($($arg)*);
        flush_stderr();
    }};
}

// ISystemMediaTransportControlsInterop: Win32 桌面应用获取 SMTC 的官方 interop
// 文档：https://learn.microsoft.com/windows/win32/api/systemmediatransportcontrolsinterop/
// IID 来自 systemmediatransportcontrolsinterop.h: 0xddb0472d-c911-4a1f-86d9-dc3d71a95f5a
//
// 不用 windows-rs 的 #[interface] 宏 —— 在 0.57 里宏生成的 vtable 调用
// 会触发 0xC0000005 崩溃。这里手动定义 vtable 布局，直接用函数指针调用。

// IInspectable 的 vtable（IUnknown 3 + IInspectable 3 = 6 个方法）
#[repr(C)]
struct IInspectableVtbl {
    query_interface: unsafe extern "system" fn(*mut core::ffi::c_void, *const GUID, *mut *mut core::ffi::c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    get_iids: unsafe extern "system" fn(*mut core::ffi::c_void, *mut u32, *mut *mut GUID) -> HRESULT,
    get_runtime_class_name: unsafe extern "system" fn(*mut core::ffi::c_void, *mut core::ffi::c_void) -> HRESULT,
    get_trust_level: unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> HRESULT,
}

// ISystemMediaTransportControlsInterop vtable = IInspectable(6) + GetForWindow(1)
#[repr(C)]
struct InteropVtbl {
    inspectable: IInspectableVtbl,
    get_for_window: unsafe extern "system" fn(*mut core::ffi::c_void, HWND, *const GUID, *mut *mut core::ffi::c_void) -> HRESULT,
}

// COM 对象：第一个字段是 vtable 指针
#[repr(C)]
struct ComObject {
    vtable: *const InteropVtbl,
}

// ISystemMediaTransportControlsInterop 的 IID
static IID_INTEROP: GUID = GUID::from_values(
    0xddb0472d, 0xc911, 0x4a1f,
    [0x86, 0xd9, 0xdc, 0x3d, 0x71, 0xa9, 0x5f, 0x5a],
);

// 通过 ISystemMediaTransportControlsInterop::GetForWindow(hwnd) 拿到 SMTC
fn get_smtc_for_window(hwnd: HWND) -> Result<SystemMediaTransportControls> {
    unsafe {
        // 1) 拿 activation factory（IInspectable）
        elog!("[smtc]   4.1: RoGetActivationFactory");
        let class_name = HSTRING::from("Windows.Media.SystemMediaTransportControls");
        let factory: IInspectable = match RoGetActivationFactory(&class_name) {
            Ok(f) => { elog!("[smtc]     factory OK"); f }
            Err(e) => { elog!("[smtc]     factory 失败: {}", e); return Err(e); }
        };

        // 2) 手动 QI 出 interop 接口
        //    用 factory 的 QueryInterface（vtable[0]）拿 interop 的原始指针
        elog!("[smtc]   4.2: QueryInterface(IID_INTEROP)");
        let factory_raw = factory.as_raw();
        elog!("[smtc]     factory_raw = {:?}", factory_raw);
        // factory_raw 指向 ComObject，第一个字段是 vtable 指针
        let factory_vtable = *(factory_raw as *const *const IInspectableVtbl);
        elog!("[smtc]     factory_vtable = {:?}", factory_vtable);
        let qi_fn = (*factory_vtable).query_interface;
        let mut interop_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let hr = qi_fn(factory_raw, &IID_INTEROP, &mut interop_ptr);
        elog!("[smtc]     QI hr = {:?}, interop_ptr = {:?}", hr, interop_ptr);
        if hr.is_err() || interop_ptr.is_null() {
            return Err(Error::from_hresult(hr));
        }

        // 3) 手动调用 GetForWindow（vtable[6]）
        elog!("[smtc]   4.3: GetForWindow (手动 vtable 调用)");
        let interop_obj = interop_ptr as *const ComObject;
        let interop_vtable = (*interop_obj).vtable;
        elog!("[smtc]     interop_vtable = {:?}", interop_vtable);
        let get_for_window_fn = (*interop_vtable).get_for_window;
        elog!("[smtc]     get_for_window_fn = {:?}", get_for_window_fn as *const ());

        let mut raw: *mut core::ffi::c_void = std::ptr::null_mut();
        let iid = IInspectable::IID;
        elog!("[smtc]     准备调用 get_for_window_fn...");
        let hr = get_for_window_fn(interop_ptr, hwnd, &iid, &mut raw);
        elog!("[smtc]     GetForWindow hr = {:?}, raw = {:?}", hr, raw);

        // 释放 interop 接口（vtable[2] = Release）
        let release_fn = (*interop_vtable).inspectable.release;
        release_fn(interop_ptr);

        if hr.is_err() || raw.is_null() {
            return Err(Error::from_hresult(hr));
        }

        // 4) 包装成 IInspectable（接管所有权），再 cast 成 SystemMediaTransportControls
        elog!("[smtc]   4.4: IInspectable::from_raw + cast");
        let insp: IInspectable = IInspectable::from_raw(raw as *mut _);
        let smtc: SystemMediaTransportControls = match insp.cast() {
            Ok(s) => { elog!("[smtc]     cast SMTC OK"); s }
            Err(e) => { elog!("[smtc]     cast SMTC 失败: {}", e); return Err(e); }
        };
        elog!("[smtc]   4.5: 完成");
        Ok(smtc)
    }
}

// ---------- 确保开始菜单存在 AUMID 匹配的快捷方式 ----------
// SMTC 显示应用名/图标的机制：系统通过当前进程的 AUMID 在开始菜单查找 .lnk 快捷方式，
// 找到则用快捷方式的显示名和图标；找不到则显示「未知应用」且无图标。
//
// 这里检查 %APPDATA%\Microsoft\Windows\Start Menu\Programs\BcsMusic.lnk 是否存在：
//   - 存在：直接返回（不重复创建，避免每次启动都改写文件）
//   - 不存在：创建快捷方式，target 指向自身 exe，设置 System.AppUserModel.ID
//
// 关键顺序：先 SetValue(AUMID) 再 Save。否则保存的 .lnk 不包含 AUMID 属性。
// 参考：https://learn.microsoft.com/windows/win32/shell/appids
fn ensure_start_menu_shortcut() -> Result<()> {
    unsafe {
        // 1) 获取 %APPDATA% 路径
        let mut buf = [0u16; 260];
        let len = GetEnvironmentVariableW(w!("APPDATA"), Some(&mut buf));
        if len == 0 {
            return Err(Error::from_win32());
        }
        let appdata = std::ffi::OsString::from_wide(&buf[..len as usize]);
        let mut lnk_path = std::path::PathBuf::from(appdata);
        lnk_path.push(r"Microsoft\Windows\Start Menu\Programs\BcsMusic.lnk");
        elog!("[smtc]   快捷方式目标路径: {}", lnk_path.display());

        // 已存在则跳过（不重复写文件）
        if lnk_path.exists() {
            elog!("[smtc]   快捷方式已存在，跳过创建");
            return Ok(());
        }

        // 2) 获取自身 exe 路径（快捷方式的 target）
        let exe_path = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                elog!("[smtc]   获取 current_exe 失败: {}", e);
                return Err(Error::from_win32());
            }
        };
        let exe_h = HSTRING::from(exe_path.as_path());
        elog!("[smtc]   target exe: {}", exe_path.display());

        // 3) CoCreateInstance(IShellLinkW)
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&exe_h)?;

        // 图标位置：优先用环境变量 BCS_ICON_PATH 指定的 .ico（由 Electron 主进程传入）
        //   - 找到则用该 .ico（开发模式：项目根/build/icon.ico）
        //   - 找不到则回退到 exe 自身图标（依赖 winres 嵌入的图标资源）
        let icon_from_env = std::env::var("BCS_ICON_PATH")
            .ok()
            .filter(|p| !p.is_empty() && std::path::Path::new(p).exists());
        if let Some(ref icon_path) = icon_from_env {
            let icon_p = std::path::Path::new(icon_path);
            elog!("[smtc]   使用 BCS_ICON_PATH 图标: {}", icon_p.display());
            let icon_h = HSTRING::from(icon_p);
            link.SetIconLocation(&icon_h, 0)?;
        } else {
            elog!("[smtc]   BCS_ICON_PATH 未设置或不存在，回退到 exe 自身图标");
            link.SetIconLocation(&exe_h, 0)?;
        }
        link.SetArguments(w!(""))?;
        link.SetDescription(w!("BcsMusic"))?;

        // 4) 设置 System.AppUserModel.ID 属性（必须在 Save 之前）
        //    用 PROPVARIANT::from(&str) 创建 VT_LPWSTR 类型（System.AppUserModel.ID 期望的类型）
        let prop_store: IPropertyStore = link.cast()?;
        let aumid_pv: PROPVARIANT = PROPVARIANT::from("com.bcsmusic.app");
        prop_store.SetValue(&PKEY_AppUserModel_ID, &aumid_pv)?;
        prop_store.Commit()?;

        // 5) 保存 .lnk 文件
        let persist_file: IPersistFile = link.cast()?;
        let lnk_h = HSTRING::from(lnk_path.as_path());
        persist_file.Save(&lnk_h, true)?;
        elog!("[smtc]   快捷方式创建成功");

        // 6) 通知系统刷新文件关联/快捷方式缓存，让 SMTC 立即查到新快捷方式
        //    SHCNE_ASSOCCHANGED：通知系统「关联已变更」，触发图标缓存重建
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        Ok(())
    }
}

fn main() {
    elog!("[smtc] === bcs-smtc 启动 ===");

    // 设置当前进程的 AppUserModelID：让 SMTC 显示「BcsMusic」而不是「未知应用」
    elog!("[smtc] 步骤1: SetCurrentProcessExplicitAppUserModelID");
    unsafe {
        let aumid = w!("com.bcsmusic.app");
        let hr = SetCurrentProcessExplicitAppUserModelID(aumid);
        elog!("[smtc]   AUMID hr = {:?}", hr);
    }

    // 初始化 WinRT 单线程套间
    elog!("[smtc] 步骤2: RoInitialize");
    if let Err(e) = unsafe { RoInitialize(RO_INIT_SINGLETHREADED) } {
        elog!("[smtc] RoInitialize failed: {}", e);
        send_event(&Event::Error { message: format!("RoInitialize: {}", e) });
        std::process::exit(1);
    }
    elog!("[smtc]   RoInitialize OK");

    // 关键：确保「开始菜单」中存在 AUMID = com.bcsmusic.app 的快捷方式
    //   SMTC 显示应用名/图标的机制：通过当前进程的 AUMID 在开始菜单中查找匹配的 .lnk。
    //   开发模式下 npm start 不会创建快捷方式，导致 SMTC 显示「未知应用」且无图标。
    //   这里检查并创建一个快捷方式到 %APPDATA%\Microsoft\Windows\Start Menu\Programs\BcsMusic.lnk，
    //   target 指向自身 exe，并设置 System.AppUserModel.ID 属性。
    //   失败不影响后续 SMTC 功能（只是名字/图标不显示）。
    elog!("[smtc] 步骤2.5: ensure_start_menu_shortcut");
    if let Err(e) = ensure_start_menu_shortcut() {
        elog!("[smtc]   创建快捷方式失败（不影响 SMTC 功能）: {}", e);
    } else {
        elog!("[smtc]   快捷方式已就绪");
    }

    // 创建隐藏顶层窗口
    elog!("[smtc] 步骤3: create_message_window");
    let hwnd = match create_message_window() {
        Ok(h) => {
            elog!("[smtc]   窗口创建 OK, hwnd = {:?}", h);
            h
        }
        Err(e) => {
            elog!("[smtc] create window failed: {}", e);
            send_event(&Event::Error { message: format!("create window: {}", e) });
            std::process::exit(2);
        }
    };

    // 通过 ISystemMediaTransportControlsInterop::GetForWindow(hwnd) 拿到 SMTC
    elog!("[smtc] 步骤4: get_smtc_for_window");
    let smtc = match get_smtc_for_window(hwnd) {
        Ok(s) => {
            elog!("[smtc]   SMTC 获取 OK");
            s
        }
        Err(e) => {
            elog!("[smtc] get_smtc_for_window failed: {}", e);
            send_event(&Event::Error { message: format!("GetForWindow: {}", e) });
            std::process::exit(3);
        }
    };

    // 配置按钮可用性（只暴露 BcsMusic 实际支持的）
    elog!("[smtc] 步骤5: configure_buttons");
    if let Err(e) = configure_buttons(&smtc) {
        elog!("[smtc] configure buttons failed: {}", e);
    }

    // 默认 playback 状态
    elog!("[smtc] 步骤6: SetPlaybackStatus(Closed)");
    let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed);

    // 注册按钮回调
    elog!("[smtc] 步骤7: register_button_handler");
    let (tx_out, rx_out) = mpsc::channel::<Event>();
    let tx_for_handler = tx_out.clone();
    if let Err(e) = register_button_handler(&smtc, tx_for_handler) {
        elog!("[smtc] register button handler failed: {}", e);
    }

    // stdin 读取线程
    let (tx_cmd, rx_cmd) = mpsc::channel::<Cmd>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(s) => {
                    let s = s.trim();
                    if s.is_empty() { continue; }
                    match serde_json::from_str::<Cmd>(s) {
                        Ok(c) => {
                            let is_exit = matches!(c, Cmd::Exit);
                            let _ = tx_cmd.send(c);
                            if is_exit { break; }
                        }
                        Err(e) => eprintln!("[smtc] cmd parse error: {} | input={}", e, s),
                    }
                }
                Err(_) => break,
            }
        }
        SHOULD_EXIT.store(true, Ordering::SeqCst);
    });

    // 通知主进程已就绪
    elog!("[smtc] 步骤8: send Ready");
    let _ = tx_out.send(Event::Ready);
    elog!("[smtc] 步骤9: 进入主循环");

    // 主消息循环：处理 stdin 命令 + 派发 Win32 消息 + 转发 SMTC 事件
    loop {
        // 1) 消费所有挂起命令（同步执行 SMTC 调用，因为我们在同一线程）
        while let Ok(cmd) = rx_cmd.try_recv() {
            let is_exit = matches!(cmd, Cmd::Exit);
            if let Err(e) = apply_cmd(&smtc, &cmd) {
                elog!("[smtc] apply cmd failed: {}", e);
                let _ = tx_out.send(Event::Error { message: e.to_string() });
            }
            if is_exit {
                SHOULD_EXIT.store(true, Ordering::SeqCst);
            }
        }
        if SHOULD_EXIT.load(Ordering::SeqCst) {
            break;
        }

        // 2) 把 SMTC 事件转发给主进程
        while let Ok(ev) = rx_out.try_recv() {
            send_event(&ev);
        }

        // 3) 派发 Win32 消息（非阻塞）
        let mut msg = MSG::default();
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    SHOULD_EXIT.store(true, Ordering::SeqCst);
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        // 4) 让出 CPU（避免忙等）
        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    // 退出前关闭 SMTC 显示
    let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed);
    let _ = smtc.SetIsEnabled(false);
    let _ = unsafe { DestroyWindow(hwnd) };
}

// ---------- 创建隐藏顶层窗口 ----------
// 注意：不能用 HWND_MESSAGE（message-only 窗口），否则
//   SystemMediaTransportControls::GetForCurrentView() 会报 0x80070578
//   "找不到要与该 MediaPlaybackControl 实例相关联的相应视图"。
//   必须创建一个真正的顶层窗口（即使不可见），SMTC 才会把它当作"当前视图"。
fn create_message_window() -> Result<HWND> {
    // 注意：w! 返回 PCWSTR（内部 *const u16，非 Sync），不能用作 static，
    // 只能在函数内 let。
    let class_name = w!("BcsSmtcHost");
    unsafe {
        let hinst = GetModuleHandleW(PCWSTR::null())?;
        let wc = WNDCLASSW {
            lpfnWndProc: Some(def_window_proc),
            lpszClassName: class_name,
            hInstance: HINSTANCE(hinst.0),
            style: WNDCLASS_STYLES::default(),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hIcon: HICON::default(),
            hCursor: HCURSOR::default(),
            hbrBackground: HBRUSH::default(),
            lpszMenuName: PCWSTR::null(),
        };
        // RegisterClassW 返回 atom（u16），0 表示失败；这里允许重复注册所以忽略
        let _atom = RegisterClassW(&wc);
        // 创建一个隐藏的顶层窗口：
        //   WS_POPUP 风格 + 不加 WS_VISIBLE，所以不会显示
        //   父窗口为 None（不是 HWND_MESSAGE）
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!("BcsSmtcHost"),
            WINDOW_STYLE(0),  // WS_POPUP = 0
            0, 0, 0, 0,
            HWND(0),  // 无父窗口，顶层窗口
            None,
            hinst,
            None,
        );
        if hwnd.0 == 0 {
            return Err(Error::from_win32());
        }
        // 给窗口发一条空消息，确保消息队列初始化、窗口已完全创建
        let _ = SendMessageW(hwnd, WM_NULL, WPARAM(0), LPARAM(0));
        Ok(hwnd)
    }
}

unsafe extern "system" fn def_window_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

// ---------- 配置按钮 ----------
// 关键：启动时 SetIsEnabled(false) —— 不显示 SMTC 条目。
//   只有当收到第一次 metadata（有歌曲）时才 SetIsEnabled(true)，
//   收到 playback:closed 时再 SetIsEnabled(false)。
//   这样启动/无歌曲时不会显示空的 SMTC 条目（标题是 AUMID）。
fn configure_buttons(s: &SystemMediaTransportControls) -> Result<()> {
    s.SetIsEnabled(false)?;
    s.SetIsPlayEnabled(true)?;
    s.SetIsPauseEnabled(true)?;
    s.SetIsNextEnabled(true)?;
    s.SetIsPreviousEnabled(true)?;
    // 关闭用不到的按钮，避免 SMTC UI 显示灰色图标
    s.SetIsStopEnabled(false)?;
    s.SetIsRewindEnabled(false)?;
    s.SetIsFastForwardEnabled(false)?;
    s.SetIsChannelUpEnabled(false)?;
    s.SetIsChannelDownEnabled(false)?;
    s.SetIsRecordEnabled(false)?;
    Ok(())
}

// ---------- 按钮事件回调 ----------
fn register_button_handler(
    s: &SystemMediaTransportControls,
    tx: mpsc::Sender<Event>,
) -> Result<()> {
    s.ButtonPressed(&TypedEventHandler::<
        SystemMediaTransportControls,
        SystemMediaTransportControlsButtonPressedEventArgs,
    >::new(move |_sender, args| {
        if let Some(args) = args {
            if let Ok(btn) = args.Button() {
                let action: Option<&'static str> = match btn {
                    SystemMediaTransportControlsButton::Play => Some("play"),
                    SystemMediaTransportControlsButton::Pause => Some("pause"),
                    SystemMediaTransportControlsButton::Next => Some("next"),
                    SystemMediaTransportControlsButton::Previous => Some("prev"),
                    _ => None,
                };
                if let Some(a) = action {
                    let _ = tx.send(Event::Action { action: a });
                }
            }
        }
        Ok(())
    }))?;
    Ok(())
}

// ---------- 执行命令 ----------
fn apply_cmd(s: &SystemMediaTransportControls, cmd: &Cmd) -> Result<()> {
    elog!("[smtc] apply_cmd: {:?}", cmd);
    match cmd {
        Cmd::Metadata { title, artist, album, cover_path } => {
            elog!("[smtc]   metadata: title={} artist={} cover={:?}", title, artist, cover_path);
            // 收到 metadata 说明有歌曲了，启用 SMTC 显示
            let _ = s.SetIsEnabled(true);
            let updater: SystemMediaTransportControlsDisplayUpdater = s.DisplayUpdater()?;
            updater.SetType(MediaPlaybackType::Music)?;
            let props: MusicDisplayProperties = updater.MusicProperties()?;
            let title_h = HSTRING::from(title.as_str());
            let artist_h = HSTRING::from(artist.as_str());
            let album_h = HSTRING::from(album.as_str());
            props.SetTitle(&title_h)?;
            props.SetArtist(&artist_h)?;
            props.SetAlbumTitle(&album_h)?;
            // 封面：从本地文件创建 RandomAccessStreamReference（尺寸无上限）
            if let Some(p) = cover_path {
                if !p.is_empty() {
                    elog!("[smtc]   封面: GetFileFromPathAsync {}", p);
                    let h = HSTRING::from(p.as_str());
                    match StorageFile::GetFileFromPathAsync(&h) {
                        Ok(op) => {
                            elog!("[smtc]     GetFileFromPathAsync OK, 等待结果...");
                            match op.get() {
                                Ok(file) => {
                                    elog!("[smtc]     file OK, CreateFromFile");
                                    match RandomAccessStreamReference::CreateFromFile(&file) {
                                        Ok(ref_) => {
                                            elog!("[smtc]     RandomAccessStreamReference OK");
                                            let _ = updater.SetThumbnail(&ref_);
                                            elog!("[smtc]     SetThumbnail 完成");
                                        }
                                        Err(e) => elog!("[smtc] CreateFromFile failed: {}", e),
                                    }
                                }
                                Err(e) => elog!("[smtc] GetFile path failed: {} | {}", e, p),
                            }
                        }
                        Err(e) => elog!("[smtc] GetFileFromPathAsync failed: {} | {}", e, p),
                    }
                }
            }
            elog!("[smtc]   updater.Update()");
            updater.Update()?;
            elog!("[smtc]   metadata 完成");
        }
        Cmd::Playback { state } => {
            elog!("[smtc]   playback: {}", state);
            let s2 = match state.as_str() {
                "playing" => MediaPlaybackStatus::Playing,
                "paused" => MediaPlaybackStatus::Paused,
                "stopped" => MediaPlaybackStatus::Stopped,
                "closed" => MediaPlaybackStatus::Closed,
                _ => return Ok(()),
            };
            s.SetPlaybackStatus(s2)?;
            // closed/stopped：无歌曲，禁用 SMTC 隐藏条目
            if matches!(s2, MediaPlaybackStatus::Closed | MediaPlaybackStatus::Stopped) {
                let _ = s.SetIsEnabled(false);
            } else {
                // playing/paused：确保 SMTC 已启用（防止 closed 后再播没启用）
                let _ = s.SetIsEnabled(true);
            }
        }
        Cmd::Position { duration_ms, position_ms } => {
            elog!("[smtc]   position: {} / {}", position_ms, duration_ms);
            // TimeSpan.Duration 单位：100ns（即 1ms = 10000）
            let scale = |ms: i64| i64::max(0, ms) * 10_000;
            let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
            timeline.SetStartTime(TimeSpan { Duration: 0 })?;
            timeline.SetEndTime(TimeSpan { Duration: scale(*duration_ms) })?;
            timeline.SetPosition(TimeSpan { Duration: scale(*position_ms) })?;
            timeline.SetMinSeekTime(TimeSpan { Duration: 0 })?;
            timeline.SetMaxSeekTime(TimeSpan { Duration: scale(*duration_ms) })?;
            s.UpdateTimelineProperties(&timeline)?;
        }
        Cmd::Exit => {}
    }
    Ok(())
}

// ---------- 工具：把 Event 序列化写到 stdout ----------
fn send_event(ev: &Event) {
    if let Ok(s) = serde_json::to_string(ev) {
        let mut out = io::stdout().lock();
        let _ = out.write_all(s.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}
