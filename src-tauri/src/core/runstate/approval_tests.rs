//! 批准与 IPC 就绪分开验证，不注册服务或改变本机批准状态。

use std::time::Duration;

use super::{FakeEnv, PendingAction, RunStateStore, ServiceHealth};

#[tokio::test]
async fn waiting_for_approval_does_not_probe_ipc_or_report_damage() {
    let env = FakeEnv::new().with_evidence(true);
    env.set_requires_approval(true);
    let store = RunStateStore::new(env);

    assert_eq!(store.observe_current_health().await, ServiceHealth::ApprovalRequired);
    assert_eq!(store.env().probe_count(), 0);
    assert!(!store.state().service_usable());
    assert!(store.state().service_needs_attention());
    assert!(!store.state().tun_should_be_disabled(true));
}

#[tokio::test]
async fn registration_success_can_still_require_approval() -> anyhow::Result<()> {
    let env = FakeEnv::new();
    env.set_requires_approval(true);
    let store = RunStateStore::new(env);
    store.request_action(PendingAction::Install);

    store.perform(PendingAction::Install).await?;

    assert_eq!(store.state().health, ServiceHealth::ApprovalRequired);
    assert_eq!(store.state().pending, None);
    assert_eq!(store.env().probe_count(), 0);
    Ok(())
}

#[tokio::test]
async fn continuing_after_approval_waits_for_ipc_before_reporting_ready() -> anyhow::Result<()> {
    let env = FakeEnv::new().replying(vec![
        Err("服务正在启动".to_owned()),
        Ok(super::ServiceVersionReply {
            code: 0,
            message: "ok".to_owned(),
            protocol: Some(clash_verge_service_ipc::ProtocolInfo::current()),
        }),
    ]);
    let store = RunStateStore::new(env);
    store.observe(ServiceHealth::ApprovalRequired);
    store.request_action(PendingAction::Install);

    store.perform(PendingAction::Install).await?;
    assert!(!store.state().service_usable());
    assert_ne!(store.state().health, ServiceHealth::ApprovalRequired);

    store
        .await_ready(2, Duration::ZERO)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    assert!(store.state().service_usable());
    assert_eq!(store.env().probe_count(), 2);
    Ok(())
}

#[tokio::test]
async fn revoked_approval_is_reported_by_the_existing_service_probe() {
    let env = FakeEnv::new().service_ready();
    env.set_requires_approval(true);
    let store = RunStateStore::new(env);
    store.observe(ServiceHealth::Ready);

    assert!(store.probe().await.is_err());
    assert_eq!(store.state().health, ServiceHealth::ApprovalRequired);
    assert_eq!(store.env().probe_count(), 0);
}

#[tokio::test]
async fn an_approved_but_incompatible_service_still_requires_reinstallation() {
    let store = RunStateStore::new(FakeEnv::new().service_version_mismatch());
    store.observe(ServiceHealth::ApprovalRequired);

    assert_eq!(store.observe_current_health().await, ServiceHealth::VersionMismatch);
    assert!(store.state().service_needs_attention());
}

#[tokio::test]
async fn uninstalling_a_service_pending_approval_still_records_its_removal() -> anyhow::Result<()> {
    let env = FakeEnv::new();
    env.set_requires_approval(true);
    let store = RunStateStore::new(env);
    store.observe(ServiceHealth::ApprovalRequired);

    store.perform(PendingAction::Uninstall).await?;

    assert_eq!(store.state().health, ServiceHealth::NotInstalled);
    assert_eq!(store.env().probe_count(), 0);
    Ok(())
}
