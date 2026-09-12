#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;
#[cfg(not(all(feature = "perf-harness", target_os = "macos")))]
use std::sync::atomic::{AtomicUsize, Ordering};

#[cfg(all(feature = "perf-harness", target_os = "macos"))]
#[path = "../../scripts/perf/app.rs"]
mod perf;

#[cfg(all(feature = "perf-harness", target_os = "macos"))]
fn main() -> ExitCode {
    perf::run()
}

#[cfg(not(all(feature = "perf-harness", target_os = "macos")))]
fn main() -> ExitCode {
    #[cfg(target_os = "macos")]
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "--smappservice") {
        return match run_macos_service() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("macOS 后台服务启动失败：{error:#}");
                ExitCode::FAILURE
            }
        };
    }
    let default_parallelism = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let worker_limit = std::cmp::min(default_parallelism, 8);
    let blocking_limit = 2 * worker_limit;

    #[allow(clippy::unwrap_used)]
    let tokio_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_limit)
        .max_blocking_threads(blocking_limit)
        .enable_all()
        .thread_name_fn(|| {
            static ATOMIC_ID: AtomicUsize = AtomicUsize::new(0);
            let id = ATOMIC_ID.fetch_add(1, Ordering::SeqCst);
            format!("clash-verge-runtime-{id}")
        })
        .build()
        .unwrap();
    let tokio_handle = tokio_runtime.handle();
    tauri::async_runtime::set(tokio_handle.clone());

    app_lib::run()
}

#[cfg(all(target_os = "macos", not(feature = "perf-harness")))]
fn run_macos_service() -> anyhow::Result<()> {
    use anyhow::{Context as _, ensure};
    use std::{env::current_exe, os::unix::process::CommandExt as _, process::Command};

    // 系统批准的 LaunchDaemon 在启动 GUI/Tokio 前进入这里；普通用户不能准备 root 的内核目录。
    ensure!(unsafe { libc::geteuid() } == 0, "此入口只能由系统后台服务运行");
    let executable = current_exe()?;
    let bin_dir = executable.parent().context("无法定位 App 可执行文件目录")?;
    let installer = bin_dir.join("../Resources/resources/clash-verge-service-install");
    // 只传包内的两个固定内核；安装器继续负责可信路径、原子复制和目录权限校验。
    let status = Command::new(installer)
        .arg("--install-core")
        .arg(bin_dir.join("verge-mihomo"))
        .arg("--install-core")
        .arg(bin_dir.join("verge-mihomo-alpha"))
        .status()
        .context("无法准备服务内核")?;
    ensure!(status.success(), "服务内核安装失败：{status}");
    Err(Command::new(bin_dir.join("clash-verge-service")).exec().into())
}
