import { check } from '@tauri-apps/plugin-updater'
import { expect, it, vi } from 'vitest'

import { checkUpdateSafe } from '../src/services/update'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))

it('自用构建不会请求或下载上游应用更新', async () => {
  await expect(checkUpdateSafe()).rejects.toThrow('此版本使用源码更新')
  expect(check).not.toHaveBeenCalled()
})
