import { Alert, Button, LinearProgress, Typography } from '@mui/material'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog } from '@/components/base'
import { useSystemState } from '@/hooks/use-system-state'
import {
  continueWithSidecar,
  installService,
  openServiceSettings,
  patchVergeConfig,
  reinstallService,
  restartCore,
  type FailedOperation,
  type PendingFailure,
  type ServiceInstallOutcome,
} from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { showNotice } from '@/services/notice-service'
import {
  clearServiceRequest,
  getServiceRequest,
  subscribeServiceRequest,
  type ServiceRequest,
  type ServiceRequestReason,
} from '@/services/service-request'
import { useAppReads } from '@/store/app-store-context'
import getSystem from '@/utils/get-system'

type Remedy = 'installAndRestart' | 'reinstallAndRestart' | 'restartOnly'

const remedyFor = (reason: ServiceRequestReason): Remedy =>
  reason === 'serviceLocationRefused' || reason === 'serviceNotAutoStarted'
    ? 'reinstallAndRestart'
    : reason === 'sysproxySidecarReady'
      ? 'restartOnly'
      : 'installAndRestart'

const EXPLANATION = {
  sysproxyRefused: 'layout.components.sysproxyPrivilege.message',
  sysproxySidecarReady:
    'layout.components.sysproxyPrivilege.serviceReadyMessage',
  tunNeedsService: 'layout.components.sysproxyPrivilege.tunMessage',
  serviceLocationRefused:
    'layout.components.serviceMigration.locationRefusedMessage',
  serviceNotAutoStarted:
    'layout.components.serviceMigration.notAutoStartedMessage',
} as const

const TITLE = {
  sysproxyRefused: 'layout.components.sysproxyPrivilege.title',
  sysproxySidecarReady: 'layout.components.sysproxyPrivilege.title',
  tunNeedsService: 'layout.components.sysproxyPrivilege.tunTitle',
  serviceLocationRefused: 'layout.components.serviceMigration.repair',
  serviceNotAutoStarted: 'layout.components.serviceMigration.repair',
} as const

const stateToRestore = (
  operation: FailedOperation,
): Partial<IVergeConfig> | undefined => {
  switch (operation) {
    case 'systemProxyEnable':
      return { enable_system_proxy: true }
    case 'systemProxyDisable':
      return { enable_system_proxy: false }
    case 'systemProxyRestore':
    case 'systemProxyGuard':
      return undefined
  }
}

const asServiceRequest = (failure: PendingFailure): ServiceRequest => ({
  reason:
    failure.code === 'SYSPROXY_SIDECAR_WHILE_SERVICE_READY'
      ? 'sysproxySidecarReady'
      : 'sysproxyRefused',
  restore: stateToRestore(failure.operation),
})

type Step = 'idle' | 'installing' | 'restarting' | 'applying'

const STEP_MESSAGE = {
  installing: 'layout.components.sysproxyPrivilege.installing',
  restarting: 'layout.components.sysproxyPrivilege.restarting',
  applying: 'layout.components.sysproxyPrivilege.applying',
} as const

/** Guide recovery from a refused system-proxy write. */
export const SysproxyPrivilegeDialog = ({
  failure,
  dismiss,
}: {
  failure: PendingFailure | null
  dismiss: () => void
}) => {
  const { readRunState } = useAppReads()
  const { t } = useTranslation()
  const { runState } = useSystemState()
  const asked = useSyncExternalStore(subscribeServiceRequest, getServiceRequest)
  const [step, setStep] = useState<Step>('idle')
  const loading = step !== 'idle'

  // Prefer the request the user just made over a pending failure.
  const request = asked ?? (failure ? asServiceRequest(failure) : null)

  const reason = request?.reason ?? 'sysproxyRefused'
  const remedy = remedyFor(reason)
  const restoring = request?.restore
  const approvalRequired = runState.service === 'approvalRequired'
  const actionLabel =
    remedy === 'reinstallAndRestart'
      ? 'layout.components.serviceMigration.reinstall'
      : remedy === 'installAndRestart' && !runState.serviceUsable
        ? 'settings.sections.proxyControl.actions.installService'
        : 'settings.sections.proxyControl.actions.switchToServiceMode'
  const explanation = step === 'idle' ? EXPLANATION[reason] : STEP_MESSAGE[step]

  const close = () => {
    clearServiceRequest()
    dismiss()
  }

  const handleLater = async () => {
    try {
      // 记录本次暂不批准的选择，避免关闭后又出现全局服务提示。
      if (approvalRequired) {
        await mutate(() => continueWithSidecar(), {
          id: 'continue-with-sidecar',
          errorNotice: false,
        })
      }
      close()
    } catch (error) {
      showNotice.error(error)
    }
  }

  const handleFix = async () => {
    try {
      const before = await readRunState()
      let outcome: ServiceInstallOutcome | undefined
      if (remedy === 'reinstallAndRestart') {
        setStep('installing')
        const result = await mutate(() => reinstallService(), {
          id: 'reinstall-service',
          errorNotice: false,
        })
        if (!result.ok) return
        outcome = result.value
      } else if (
        before.service === 'approvalRequired' ||
        (remedy === 'installAndRestart' &&
          (!before.serviceUsable || before.sidecarAllowed))
      ) {
        setStep('installing')
        const result = await mutate(() => installService(), {
          id: 'install-service',
          errorNotice: false,
        })
        if (!result.ok) return
        outcome = result.value
      }
      if (outcome && (await readRunState()).service === 'approvalRequired')
        return
      if (outcome?.status === 'sidecar') {
        showNotice.warning(
          'settings.feedback.notifications.clashService.permissionFallback',
          { reason: outcome.reason },
          0,
        )
        close()
        return
      }
      setStep('restarting')
      await mutate(() => restartCore(), {
        id: 'restart-core',
        errorNotice: false,
      })

      const runState = await readRunState()
      const usingAdminFallback =
        remedy !== 'reinstallAndRestart' &&
        getSystem() === 'windows' &&
        runState.mode === 'Sidecar' &&
        runState.isAdmin &&
        runState.sidecarAllowed &&
        runState.service === 'unavailable'
      if (runState.mode === 'Service' || usingAdminFallback) {
        if (restoring !== undefined) {
          setStep('applying')
          await mutate(() => patchVergeConfig(restoring), {
            id: 'sysproxy-privilege-restore',
            errorNotice: false,
          })
        }
        if (!usingAdminFallback) {
          showNotice.success(
            remedy === 'reinstallAndRestart'
              ? 'layout.components.serviceMigration.success'
              : restoring === undefined
                ? 'settings.sections.proxyControl.messages.installedCheckProxy'
                : 'settings.sections.proxyControl.messages.installedProxyRestored',
          )
        }
        close()
      } else {
        showNotice.error(
          'settings.sections.proxyControl.messages.installedCoreNotOnService',
        )
      }
    } catch (error) {
      showNotice.error(error)
    } finally {
      setStep('idle')
    }
  }

  return (
    <BaseDialog
      open={Boolean(request)}
      title={t(
        approvalRequired
          ? 'layout.components.serviceMigration.approvalTitle'
          : TITLE[reason],
      )}
      okBtn={t(
        approvalRequired
          ? 'layout.components.serviceMigration.resume'
          : actionLabel,
      )}
      cancelBtn={t('layout.components.sysproxyPrivilege.later')}
      // Keep the primary spinner visible; only cancellation is unavailable.
      disableCancel={loading}
      loading={loading}
      onOk={() => void handleFix()}
      onCancel={() => void handleLater()}
      onClose={() => void handleLater()}
    >
      <Alert
        severity={loading ? 'info' : 'warning'}
        sx={{ mb: 1.5 }}
        action={
          approvalRequired &&
          !loading && (
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
          approvalRequired && !loading
            ? 'layout.components.serviceMigration.approvalMessage'
            : explanation,
        )}
      </Alert>
      {loading && <LinearProgress />}
      {!loading && reason === 'sysproxyRefused' && (
        <Typography variant="body2" color="text.secondary">
          {t('layout.components.sysproxyPrivilege.alternative')}
        </Typography>
      )}
    </BaseDialog>
  )
}
