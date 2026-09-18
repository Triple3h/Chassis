fn main() {
    // 二进制热更新的自检入口（`hot/binary.rs::probe`）：**最先**处理，不初始化任何东西。
    //
    // 这里的 println! 走的是**这个短命进程自己的 stdout**（它不连壳、不参与内核协议），
    // 与「内核协议只走 stdout、日志走 stderr」的铁律不冲突 —— 自检报告就是它的全部输出。
    if std::env::args().skip(1).any(|arg| arg == "--hot-probe") {
        let probe = serde_json::json!({
            "version": launcher_kernel::VERSION,
            "hotVersion": launcher_kernel::hot::HOT_UPDATE_VERSION,
        });
        println!("{probe}");
        return;
    }

    // 内核是 IO 密集 + 少量 CPU（搜索打分）：2 个 worker 线程足够（省内存，见 m5 计划 §1.2）
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            launcher_kernel::logging::emit("error", &format!("创建 tokio 运行时失败：{err}"));
            std::process::exit(1);
        }
    };
    let code = runtime.block_on(launcher_kernel::run());
    std::process::exit(code);
}
