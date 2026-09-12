import { useCallback } from 'react'

import { getRuntimeState, installService, restartCore } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { setCacheData } from '@/services/query-client'

import { runStateQueryKey } from './use-system-state'

export const useServiceInstaller = () => {
  const installServiceAndRestartCore = useCallback(async () => {
    try {
      showNotice.info('settings.statuses.clashService.installing')
      await installService()
      const state = await getRuntimeState()
      setCacheData(runStateQueryKey, state)
      if (state.service === 'approvalRequired') return
      showNotice.success(
        'settings.feedback.notifications.clashService.installSuccess',
      )

      showNotice.info('settings.statuses.clash.restarting')
      await restartCore()
      showNotice.success('settings.feedback.notifications.clash.restartSuccess')
    } catch (error) {
      showNotice.error(error)
      throw error
    }
  }, [])
  return { installServiceAndRestartCore }
}
