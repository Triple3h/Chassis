// Windows 下隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 自更新链路的自检入口（对应内核的 `--hot-probe`）：不启 GUI、不连内核，只打印一行 JSON。
    // 必须排在 `run()` 之前 —— 候选包还没被系统注册，起 GUI 会抢焦点、也可能被 Gatekeeper 拦半截。
    if std::env::args().any(|arg| arg == "--hot-probe") {
        println!("{}", launcher_shell_lib::probe_report());
        return;
    }
    launcher_shell_lib::run()
}
