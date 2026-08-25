// build.rs — 让 winres 给 bcs-smtc.exe 嵌入 Windows 版本资源 + 图标
// 用途：
//   1. Windows 资源管理器「属性 → 详细信息」显示「BcsMusic」而不是「bcs-smtc.exe」
//   2. SMTC 创建的开始菜单快捷方式图标显示软件 logo（SetIconLocation 指向 exe 自身时
//      Windows 从 exe 资源段读取图标）
//
// 图标来源：项目根目录 build/icon.ico（开发与打包都用同一个）
//   - 找不到则跳过图标嵌入（仅嵌入版本信息字符串）
//
// 仅在 Windows 上编译资源；Linux 上是 no-op（避免交叉编译时找不到 rc.exe）
fn main() {
    #[cfg(target_os = "windows")]
    {
        let mut res = winres::WindowsResource::new();
        res.set_manifest_file("none");

        // 嵌入图标：相对 smtc-native 目录的 ../build/icon.ico
        //   cargo build 的工作目录是 smtc-native/，所以 ../build/icon.ico 指向项目根/build/icon.ico
        let icon_rel = "../build/icon.ico";
        if std::path::Path::new(icon_rel).exists() {
            res.set_icon(icon_rel);
            println!("cargo:warning=[build.rs] 嵌入图标: {}", icon_rel);
        } else {
            println!("cargo:warning=[build.rs] 未找到 ../build/icon.ico，跳过图标嵌入");
        }

        if let Err(e) = res.compile() {
            println!("cargo:warning=Failed to compile Windows resource: {}", e);
            println!("cargo:warning=  → 若要嵌入图标/版本信息，需安装 Windows SDK（提供 rc.exe）");
            println!("cargo:warning=  → 不影响主程序构建，SMTC 仍可用（仅 exe 无图标）");
            // 不 panic：资源编译失败不应阻断主程序构建
        }
    }
    // 让 cargo 在 build.rs / icon.ico 修改时重跑
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../build/icon.ico");
}
