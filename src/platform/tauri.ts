import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Attachment, PlatformCapabilities } from '../domain/models'
import { createNativeAdapter, readImageBytes } from './native'

export function createTauriAdapter(platform: PlatformCapabilities['platform']) {
  return createNativeAdapter(invoke, convertFileSrc, platform, async (file) => {
    const bytes = await readImageBytes(file)
    if (platform === 'windows') {
      return invoke<Attachment>('import_image_bytes', bytes, {
        headers: { 'x-file-name': encodeURIComponent(file.name) },
      })
    }
    // Android's Tauri IPC uses JSON rather than raw request bodies.
    return invoke<Attachment>('import_image', { originalName: file.name, bytes: Array.from(bytes) })
  })
}

export async function registerCloseGuard(save: () => Promise<void>, onError: (error: unknown) => void) {
  const window = getCurrentWindow()
  return window.onCloseRequested(async (event) => {
    event.preventDefault()
    try {
      await save()
      await window.destroy()
    } catch (error) {
      onError(error)
    }
  })
}
