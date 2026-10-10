import { Alert, Button } from '@mui/material'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog } from '@/components/base'
import {
  continueWithSidecar,
  installService,
  openServiceSettings,
  reinstallService,
  repairService,
  restartCore,
  type ServiceInstallOutcome,
} from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { showNotice } from '@/services/notice-service'
import {
  getServiceRequest,
  subscribeServiceRequest,
} from '@/services/service-request'
import { useAppReads, useRunState } from '@/store/app-store-context'

const ACTION_LABEL = {
  install: 'settings.sections.proxyControl.actions.installService',
  repair: 'layout.components.serviceMigration.repair',
  reinstall: 'layout.components.serviceMigration.reinstall',
} as const

export const ServiceMigrationDialog = ({
  proxyDialogOpen,
}: {
  proxyDialogOpen: boolean
}) => {
  const { t } = useTranslation()
  const serviceRequest = useSyncExternalStore(
    subscribeServiceRequest,
    getServiceRequest,
  )
  const [loading, setLoading] = useState(false)
  const [stateRefreshFailed, setStateRefreshFailed] = useState(false)
  const [workflowIncomplete, setWorkflowIncomplete] = useState(false)
  const { readRunState } = useAppReads()
  const runState = useRunState()
  // Whether the service needs a decision is derived once, in Rust, and travels with the
  // snapshot; a failed refresh is treated as needing one, since we cannot tell otherwise.
  const needsDecision =
    stateRefreshFailed || Boolean(runState?.serviceNeedsAttention)
  const approvalRequired = runState?.service === 'approvalRequired'
  // Treat refresh failures as unreachable; an absent Service still needs install after a failed Sidecar attempt.
  const remedy: 'install' | 'repair' | 'reinstall' =
    approvalRequired || runState?.pendingAction === 'install'
      ? 'install'
      : stateRefreshFailed || runState?.service === 'unavailable'
        ? 'repair'
        : runState?.service === 'notInstalled'
          ? 'install'
          : 'reinstall'
  // 原操作的对话框负责恢复 TUN/系统代理，避免同时弹出两个批准引导。
  const open =
    (loading || workflowIncomplete || needsDecision) &&
    !serviceRequest &&
    !proxyDialogOpen
  const checking =
    loading ||
    !runState ||
    runState.opInFlight ||
    runState.service === 'unknown'
  const showCheckingMessage = checking || !needsDecision
  const explanation = showCheckingMessage
    ? 'layout.components.serviceMigration.checkingMessage'
    : remedy === 'reinstall'
      ? 'layout.components.serviceMigration.message'
      : 'layout.components.serviceMigration.unavailableMessage'
  const canContinue = Boolean(
    runState &&
      !stateRefreshFailed &&
      (runState.pendingAction === 'install'
        ? runState.mode === 'NotRunning' || runState.mode === 'Sidecar'
        : !runState.pendingAction &&
          !runState.sidecarAllowed &&
          ((approvalRequired &&
            (runState.mode === 'NotRunning' || runState.mode === 'Sidecar')) ||
            (runState.mode === 'NotRunning' &&
              (runState.service === 'notInstalled' ||
                runState.service === 'versionMismatch' ||
                runState.service === 'unavailable')))),
  )

  // One store entry to refresh, so there is nothing left to keep coherent by hand.
  const refreshRunState = async () => {
    try {
      const data = await readRunState()
      setStateRefreshFailed(false)
      return data
    } catch (error) {
      setStateRefreshFailed(true)
      throw error
    }
  }

  const handleServiceAction = async () => {
    setLoading(true)
    setWorkflowIncomplete(true)
    let outcome: ServiceInstallOutcome | undefined
    try {
      if (remedy === 'install') {
        const result = await mutate(() => installService(), {
          id: 'install-service',
          errorNotice: false,
        })
        if (result.ok) outcome = result.value
      } else if (remedy === 'repair') {
        const result = await mutate(() => repairService(), {
          id: 'repair-service',
          errorNotice: false,
        })
        if (result.ok) outcome = result.value
      } else {
        const result = await mutate(() => reinstallService(), {
          id: 'reinstall-service',
          errorNotice: false,
        })
        if (result.ok) outcome = result.value
      }
    } catch (error) {
      showNotice.error(
        'layout.components.serviceMigration.errors.actionFailed',
        error,
      )
    }

    let initialRefreshSucceeded = false
    try {
      const state = await refreshRunState()
      if (state.service === 'approvalRequired') {
        setLoading(false)
        return
      }
      initialRefreshSucceeded = true
    } catch (error) {
      showNotice.error(
        'layout.components.serviceMigration.errors.stateRefreshFailed',
        error,
      )
    }
    if (!outcome || !initialRefreshSucceeded) {
      setLoading(false)
      return
    }
    if (outcome.status === 'sidecar') {
      setWorkflowIncomplete(false)
      setLoading(false)
      showNotice.warning(
        'settings.feedback.notifications.clashService.permissionFallback',
        { reason: outcome.reason },
        0,
      )
      return
    }

    let restartSucceeded = false
    try {
      const result = await mutate(() => restartCore(), {
        id: 'restart-core',
        errorNotice: false,
      })
      restartSucceeded = result.ok
    } catch (error) {
      showNotice.error(
        'layout.components.serviceMigration.errors.restartFailed',
        error,
      )
    }

    let finalRefreshSucceeded = false
    try {
      await refreshRunState()
      finalRefreshSucceeded = true
    } catch (error) {
      showNotice.error(
        'layout.components.serviceMigration.errors.stateRefreshFailed',
        error,
      )
    }
    if (restartSucceeded && finalRefreshSucceeded) {
      setWorkflowIncomplete(false)
      showNotice.success('layout.components.serviceMigration.success')
    }
    setLoading(false)
  }

  const handleContinue = async () => {
    setLoading(true)
    setWorkflowIncomplete(true)
    let startupError: unknown
    try {
      await mutate(() => continueWithSidecar(), {
        id: 'continue-with-sidecar',
        errorNotice: false,
      })
    } catch (error) {
      startupError = error
    }

    let installRefreshSucceeded = false
    try {
      await refreshRunState()
      installRefreshSucceeded = true
    } catch (error) {
      showNotice.error(
        'layout.components.serviceMigration.errors.stateRefreshFailed',
        error,
      )
    }
    if (startupError) {
      showNotice.error(
        'layout.components.serviceMigration.errors.sidecarFailed',
        startupError,
      )
    } else if (installRefreshSucceeded) {
      setWorkflowIncomplete(false)
    }
    setLoading(false)
  }

  return (
    <BaseDialog
      open={open}
      title={t(
        approvalRequired
          ? 'layout.components.serviceMigration.approvalTitle'
          : 'layout.components.serviceMigration.title',
      )}
      okBtn={t(
        approvalRequired
          ? 'layout.components.serviceMigration.resume'
          : ACTION_LABEL[remedy],
      )}
      cancelBtn={t('layout.components.serviceMigration.continueSidecar')}
      disableOk={checking}
      disableCancel={checking || !canContinue}
      loading={loading}
      onOk={() => void handleServiceAction()}
      onCancel={() => void handleContinue()}
    >
      <Alert
        severity="warning"
        action={
          approvalRequired && (
            <Button
              onClick={() =>
                void openServiceSettings().catch((error) =>
                  showNotice.error(error),
                )
              }
            >
              {t('layout.components.serviceMigration.openSettings')}
            </Button>
          )
        }
      >
        {t(
          approvalRequired
            ? 'layout.components.serviceMigration.approvalMessage'
            : explanation,
        )}
      </Alert>
    </BaseDialog>
  )
}
