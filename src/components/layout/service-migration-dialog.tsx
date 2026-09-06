import { Alert, Button } from '@mui/material'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog } from '@/components/base'
import { runStateQueryKey } from '@/hooks/use-system-state'
import { useVisibility } from '@/hooks/use-visibility'
import {
  continueWithSidecar,
  getRuntimeState,
  installService,
  openServiceSettings,
  reinstallService,
  repairService,
  restartCore,
  type RunState,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { setCacheDataAsync, useQuery } from '@/services/query-client'
import {
  getServiceRequest,
  subscribeServiceRequest,
} from '@/services/service-request'

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
  const pageVisible = useVisibility()
  const serviceRequest = useSyncExternalStore(
    subscribeServiceRequest,
    getServiceRequest,
  )
  const [loading, setLoading] = useState(false)
  const [stateRefreshFailed, setStateRefreshFailed] = useState(false)
  const [workflowIncomplete, setWorkflowIncomplete] = useState(false)
  const { data: runState } = useQuery({
    queryKey: runStateQueryKey,
    queryFn: getRuntimeState,
    enabled: true,
    retry: 1,
    refetchInterval: pageVisible ? 30000 : false,
  })
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
  const showCheckingMessage = loading || !needsDecision
  const explanation = showCheckingMessage
    ? 'layout.components.serviceMigration.checkingMessage'
    : remedy === 'reinstall'
      ? 'layout.components.serviceMigration.message'
      : 'layout.components.serviceMigration.unavailableMessage'

  // One cache entry to refresh, so there is nothing left to keep coherent by hand.
  const refreshRunState = async () => {
    try {
      const data = await getRuntimeState()
      await setCacheDataAsync<RunState>(runStateQueryKey, data)
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
    let actionSucceeded = false
    try {
      if (remedy === 'install') {
        await installService()
      } else if (remedy === 'repair') {
        await repairService()
      } else {
        await reinstallService()
      }
      actionSucceeded = true
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
    if (!actionSucceeded || !initialRefreshSucceeded) {
      setLoading(false)
      return
    }

    let restartSucceeded = false
    try {
      await restartCore()
      restartSucceeded = true
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
      await continueWithSidecar()
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
      disableOk={loading}
      disableCancel={loading}
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
