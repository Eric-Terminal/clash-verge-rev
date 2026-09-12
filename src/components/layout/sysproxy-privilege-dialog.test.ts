import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ServiceMigrationDialog } from './service-migration-dialog'
import { SysproxyPrivilegeDialog } from './sysproxy-privilege-dialog'

const mocks = vi.hoisted(() => ({
  state: {
    service: 'approvalRequired',
    serviceUsable: false,
    sidecarAllowed: false,
    mode: 'Sidecar',
  },
  onOk: () => {},
  onSettings: () => {},
  onCancel: () => {},
  getRuntimeState: vi.fn(),
  installService: vi.fn(),
  reinstallService: vi.fn(),
  repairService: vi.fn(),
  continueWithSidecar: vi.fn(),
  openServiceSettings: vi.fn(),
  restartCore: vi.fn(),
  patchVergeConfig: vi.fn(),
  clearServiceRequest: vi.fn(),
  getServiceRequest: vi.fn(),
  setCacheData: vi.fn(),
  dismiss: vi.fn(),
  notice: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) =>
    getSnapshot(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@mui/material', () => ({
  Alert: ({ action }: { action?: ReactNode }) => action ?? null,
  Button: ({ onClick }: { onClick: () => void }) => {
    mocks.onSettings = onClick
    return null
  },
  LinearProgress: () => null,
  Typography: () => null,
}))
vi.mock('@/components/base', () => ({
  BaseDialog: ({
    onOk,
    onCancel,
    children,
  }: {
    onOk: () => void
    onCancel: () => void
    children: ReactNode
  }) => {
    mocks.onOk = onOk
    mocks.onCancel = onCancel
    return children
  },
}))
vi.mock('@/hooks/use-system-state', () => ({
  runStateQueryKey: ['getRuntimeState'],
  useSystemState: () => ({
    runState: mocks.state,
  }),
}))
vi.mock('@/services/cmds', () => mocks)
vi.mock('@/services/notice-service', () => ({ showNotice: mocks.notice }))
vi.mock('@/services/query-client', () => ({
  setCacheData: mocks.setCacheData,
  useQuery: () => ({ data: { ...mocks.state, serviceNeedsAttention: true } }),
}))
vi.mock('@/hooks/use-visibility', () => ({ useVisibility: () => true }))
vi.mock('@/services/service-request', () => ({
  getServiceRequest: mocks.getServiceRequest,
  subscribeServiceRequest: vi.fn(),
  clearServiceRequest: mocks.clearServiceRequest,
}))

// 渲染真实组件取得按钮回调，只替换 UI 外壳和系统边界，不执行本机代理操作。
const clickButton = async (
  button: 'continue' | 'settings' | 'later' = 'continue',
) => {
  renderToStaticMarkup(
    createElement(SysproxyPrivilegeDialog, {
      failure: null,
      dismiss: mocks.dismiss,
    }),
  )
  if (button === 'settings') mocks.onSettings()
  else if (button === 'later') mocks.onCancel()
  else mocks.onOk()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.openServiceSettings.mockResolvedValue(undefined)
  mocks.getServiceRequest.mockReturnValue({
    reason: 'tunNeedsService',
    restore: { enable_tun_mode: true },
  })
  mocks.state = {
    service: 'approvalRequired',
    serviceUsable: false,
    sidecarAllowed: false,
    mode: 'Sidecar',
  }
  mocks.getRuntimeState.mockImplementation(() => Promise.resolve(mocks.state))
})

describe('启动时继续后台服务批准', () => {
  it.each([
    ['尚未批准时保留引导', 'approvalRequired', 0],
    ['批准后启动内核', 'ready', 1],
  ] as const)('%s', async (_description, health, restarts) => {
    mocks.getServiceRequest.mockReturnValue(null)
    mocks.installService.mockImplementation(() => {
      mocks.state.service = health
      mocks.state.serviceUsable = health === 'ready'
    })
    renderToStaticMarkup(
      createElement(ServiceMigrationDialog, { proxyDialogOpen: false }),
    )

    mocks.onOk()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mocks.installService).toHaveBeenCalledOnce()
    expect(mocks.reinstallService).not.toHaveBeenCalled()
    expect(mocks.repairService).not.toHaveBeenCalled()
    expect(mocks.restartCore).toHaveBeenCalledTimes(restarts)
    expect(mocks.notice.success).toHaveBeenCalledTimes(restarts)
  })
})

describe('TUN 请求跨越系统批准流程', () => {
  it('稍后批准时沿用本次 Sidecar 选择并关闭请求', async () => {
    await clickButton('later')

    expect(mocks.continueWithSidecar).toHaveBeenCalledOnce()
    expect(mocks.clearServiceRequest).toHaveBeenCalledOnce()
    expect(mocks.dismiss).toHaveBeenCalledOnce()
    expect(mocks.installService).not.toHaveBeenCalled()
  })

  it('无法继续 Sidecar 时保留弹窗和原请求', async () => {
    mocks.continueWithSidecar.mockRejectedValue(new Error('内核启动失败'))
    await clickButton('later')

    expect(mocks.notice.error).toHaveBeenCalledOnce()
    expect(mocks.clearServiceRequest).not.toHaveBeenCalled()
    expect(mocks.dismiss).not.toHaveBeenCalled()
  })

  it('等待批准时打开系统设置并保留原 TUN 请求', async () => {
    await clickButton('settings')

    expect(mocks.openServiceSettings).toHaveBeenCalledOnce()
    expect(mocks.installService).not.toHaveBeenCalled()
    expect(mocks.restartCore).not.toHaveBeenCalled()
    expect(mocks.patchVergeConfig).not.toHaveBeenCalled()
    expect(mocks.clearServiceRequest).not.toHaveBeenCalled()
  })

  it('批准后继续启动服务内核并恢复 TUN，不重复安装', async () => {
    mocks.state = {
      service: 'ready',
      serviceUsable: true,
      sidecarAllowed: false,
      mode: 'Sidecar',
    }
    mocks.restartCore.mockImplementation(() => {
      mocks.state.mode = 'Service'
    })

    await clickButton()

    expect(mocks.installService).not.toHaveBeenCalled()
    expect(mocks.restartCore).toHaveBeenCalledOnce()
    expect(mocks.patchVergeConfig).toHaveBeenCalledWith({
      enable_tun_mode: true,
    })
    expect(mocks.clearServiceRequest).toHaveBeenCalledOnce()
  })

  it('新注册仍需批准时不提前重启或写入 TUN 设置', async () => {
    mocks.state.service = 'notInstalled'
    mocks.installService.mockImplementation(() => {
      mocks.state.service = 'approvalRequired'
    })

    await clickButton()

    expect(mocks.installService).toHaveBeenCalledOnce()
    expect(mocks.restartCore).not.toHaveBeenCalled()
    expect(mocks.patchVergeConfig).not.toHaveBeenCalled()
    expect(mocks.clearServiceRequest).not.toHaveBeenCalled()
  })

  it('批准后内核启动失败时保留请求以便重试', async () => {
    mocks.state = {
      service: 'ready',
      serviceUsable: true,
      sidecarAllowed: false,
      mode: 'Sidecar',
    }
    mocks.restartCore.mockRejectedValue(new Error('内核启动失败'))

    await clickButton()

    expect(mocks.notice.error).toHaveBeenCalledOnce()
    expect(mocks.patchVergeConfig).not.toHaveBeenCalled()
    expect(mocks.clearServiceRequest).not.toHaveBeenCalled()
  })

  it('返回后点击继续，通过安装入口确认批准并恢复 TUN', async () => {
    mocks.installService.mockImplementation(() => {
      mocks.state.service = 'ready'
      mocks.state.serviceUsable = true
    })
    mocks.restartCore.mockImplementation(() => {
      mocks.state.mode = 'Service'
    })

    await clickButton()

    expect(mocks.installService).toHaveBeenCalledOnce()
    expect(mocks.restartCore).toHaveBeenCalledOnce()
    expect(mocks.patchVergeConfig).toHaveBeenCalledWith({
      enable_tun_mode: true,
    })
    expect(mocks.clearServiceRequest).toHaveBeenCalledOnce()
  })

  it('尚未批准时点击继续，不启动内核也不丢弃请求', async () => {
    await clickButton()

    expect(mocks.installService).toHaveBeenCalledOnce()
    expect(mocks.restartCore).not.toHaveBeenCalled()
    expect(mocks.clearServiceRequest).not.toHaveBeenCalled()
    expect(mocks.notice.success).not.toHaveBeenCalled()
  })
})
