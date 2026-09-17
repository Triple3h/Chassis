//! 壳 ↔ 内核协议层的黑盒测试（语义对齐 v1 `jsonrpc.ts`）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use launcher_kernel::error::KernelError;
use launcher_kernel::link::{OutputFn, ShellLink};
use serde_json::{json, Value};

fn collector() -> (OutputFn, Arc<Mutex<Vec<String>>>) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let output: OutputFn = Arc::new(move |line: String| {
        sink.lock().unwrap_or_else(|err| err.into_inner()).push(line);
    });
    (output, lines)
}

fn parse_lines(lines: &Arc<Mutex<Vec<String>>>) -> Vec<Value> {
    lines
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .iter()
        .map(|line| serde_json::from_str(line.trim_end()).expect("写出的必须是合法 JSON 行"))
        .collect()
}

async fn feed(link: &ShellLink, input: &str) {
    link.read_loop(tokio::io::BufReader::new(input.as_bytes())).await;
}

/// 等内核写出第 `count` 行：handler 是 **spawn** 执行的（读循环绝不内联 await，见 link.rs），
/// 所以应答是异步到达的 —— 断言前要等一等。
async fn wait_lines(lines: &Arc<Mutex<Vec<String>>>, count: usize) {
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while lines.lock().unwrap_or_else(|err| err.into_inner()).len() < count {
        assert!(std::time::Instant::now() < deadline, "等待内核写出第 {count} 行超时");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn dispatches_request_and_replies() {
    let (output, lines) = collector();
    let link = ShellLink::new(output);
    link.handle("app/info", |_params: Value| async { Ok(json!({ "ok": true })) });

    feed(&link, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"app/info\"}\n").await;
    wait_lines(&lines, 1).await;

    let written = parse_lines(&lines);
    assert_eq!(written.len(), 1);
    assert_eq!(written[0]["jsonrpc"], "2.0");
    assert_eq!(written[0]["id"], 1);
    assert_eq!(written[0]["result"]["ok"], true);
}

#[tokio::test]
async fn unknown_method_gets_minus_32601() {
    let (output, lines) = collector();
    let link = ShellLink::new(output);

    feed(&link, "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"nope\"}\n").await;

    let written = parse_lines(&lines);
    assert_eq!(written.len(), 1);
    assert_eq!(written[0]["error"]["code"], -32601);
}

#[tokio::test]
async fn notification_without_id_produces_no_reply() {
    let (output, lines) = collector();
    let link = ShellLink::new(output);
    link.handle("app/info", |_params: Value| async { Ok(json!({ "ok": true })) });

    feed(&link, "{\"jsonrpc\":\"2.0\",\"method\":\"app/info\"}\n").await;
    // handler 是 spawn 的：等一下再断言「什么都没写」（不是「还没轮到写」）
    tokio::time::sleep(Duration::from_millis(20)).await;

    assert!(parse_lines(&lines).is_empty(), "无 id 的通知不应产生应答");
}

#[tokio::test]
async fn handler_error_maps_to_minus_32000() {
    let (output, lines) = collector();
    let link = ShellLink::new(output);
    link.handle("open/url", |_params: Value| async { Err(KernelError::bad_args("url 不合法")) });

    feed(&link, "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"open/url\"}\n").await;
    wait_lines(&lines, 1).await;

    let written = parse_lines(&lines);
    assert_eq!(written[0]["error"]["code"], -32000);
    assert_eq!(written[0]["error"]["message"], "url 不合法");
}

#[tokio::test]
async fn request_resolves_when_response_arrives() {
    let (output, lines) = collector();
    let link = ShellLink::new(output);
    link.mark_connected();

    let reader_link = link.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        reader_link
            .read_loop(tokio::io::BufReader::new("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"uiPort\":64001}}\n".as_bytes()))
            .await;
    });

    let result = link
        .request_with_timeout("kernel/ready", None, Duration::from_secs(2))
        .await
        .expect("应当收到应答");
    assert_eq!(result.get("uiPort").and_then(Value::as_u64), Some(64001));

    let written = parse_lines(&lines);
    assert_eq!(written.len(), 1);
    assert_eq!(written[0]["method"], "kernel/ready");
    assert_eq!(written[0]["id"], 1);
    assert!(written[0].get("params").is_none(), "无参数时不应写 params 字段");
}

#[tokio::test]
async fn request_times_out_without_response() {
    let (output, _lines) = collector();
    let link = ShellLink::new(output);
    link.mark_connected();

    let err = link
        .request_with_timeout("window/show", None, Duration::from_millis(30))
        .await
        .expect_err("没有应答必须超时");
    assert_eq!(err.code, "TIMEOUT");
}

#[tokio::test]
async fn request_fails_fast_when_disconnected_and_notify_is_dropped() {
    let (output, lines) = collector();
    let link = ShellLink::new(output);

    let err = link
        .request_with_timeout("window/show", None, Duration::from_millis(50))
        .await
        .expect_err("未连接必须立即失败");
    assert_eq!(err.code, "NOT_FOUND");

    link.notify("kernel/ready", None);
    assert!(parse_lines(&lines).is_empty(), "未连接时通知应静默丢弃");
}
