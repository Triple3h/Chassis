fn main() {
    // 壳版本从 `tauri.conf.json` 的 `version` 读；它的**唯一维护点是根 `version.json`**
    // （`scripts/version.mjs` 同步，`pnpm version:check` 拦漂移）——别手改那两处文件。
    //
    // 这个值同时决定三件事，分叉会让自更新链路静默失效：
    //  1. `package_info().version`（外置内核台账的 `sourceAppVersion`）；
    //  2. `Info.plist` 的 `CFBundleShortVersionString`（打包脚本也从这里读，见 pack-local-app.mjs）；
    //  3. `--hot-probe` 自报的版本（自更新用它判断「候选包比当前包新吗」）。
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let raw = std::fs::read_to_string("tauri.conf.json").expect("读不到 apps/shell/tauri.conf.json");
    let version = raw
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .expect("tauri.conf.json 顶层没有 version");
    println!("cargo:rustc-env=SHELL_VERSION={version}");
    tauri_build::build()
}
