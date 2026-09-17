fn main() {
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
