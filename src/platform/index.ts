import { invoke } from '@tauri-apps/api/core'
import { registerCloseGuard as registerTauriCloseGuard } from './tauri'
import { registerHarmonyCloseGuard } from './harmonyos'
import { createHarmonyHost } from './harmonyos-host'
import type { NativeInvoke } from './native'
import { EncryptedWorkspace } from '../security/workspace'
import { encodeBase64 } from '../security/crypto'
import type { ExportFile } from '../export/types'

const harmonyHost = 'inspNative' in window ? createHarmonyHost() : null

const nativeInvoke: NativeInvoke = harmonyHost
  ? async <T>(command: string, args?: Record<string, unknown>) => JSON.parse(await harmonyHost.request(command, JSON.stringify(args ?? {}))) as T
  : invoke
export const vault = new EncryptedWorkspace(nativeInvoke, harmonyHost ? 'harmonyos' : import.meta.env.TAURI_ENV_PLATFORM === 'android' ? 'android' : 'windows')
export const platform = vault.platform

export function registerCloseGuard(save: () => Promise<void>, onError: (error: unknown) => void) {
  return harmonyHost
    ? registerHarmonyCloseGuard(harmonyHost, save, onError)
    : registerTauriCloseGuard(save, onError)
}

export function getDeviceInsets() {
  return nativeInvoke<{ top: number; bottom: number; left: number; right: number }>('device_insets')
}

export function setDeviceAppearance(dark: boolean) {
  return nativeInvoke<void>('device_set_appearance', { dark })
}

async function filePayload(file: ExportFile) {
  const bytes = new Uint8Array(await file.blob.arrayBuffer())
  return { name: file.filename, mimeType: file.mimeType, base64: encodeBase64(bytes) }
}

export async function shareNoteText(text: string, title: string): Promise<'shared' | 'copied'> {
  if (platform.capabilities.platform !== 'windows') {
    await nativeInvoke<void>('device_share_text', { text })
    return 'shared'
  }
  await navigator.clipboard.writeText(text)
  if (navigator.share) {
    await navigator.share({ title, text })
    return 'shared'
  }
  return 'copied'
}

export async function shareNoteImage(file: ExportFile): Promise<'shared' | 'copied'> {
  if (platform.capabilities.platform !== 'windows') {
    await nativeInvoke<void>('device_share_file', await filePayload(file))
    return 'shared'
  }
  const image = new File([file.blob], file.filename, { type: file.mimeType })
  if (navigator.canShare?.({ files: [image] })) {
    await navigator.share({ files: [image] })
    return 'shared'
  }
  await navigator.clipboard.write([new ClipboardItem({ [file.mimeType]: file.blob })])
  return 'copied'
}

export async function saveNoteExport(file: ExportFile): Promise<boolean> {
  if (platform.capabilities.platform !== 'windows') return nativeInvoke<boolean>('device_save_file', await filePayload(file))
  const picker = window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(blob: Blob): Promise<void>; close(): Promise<void> }> }> }
  if (picker.showSaveFilePicker) {
    const handle = await picker.showSaveFilePicker({ suggestedName: file.filename })
    const writable = await handle.createWritable()
    await writable.write(file.blob)
    await writable.close()
    return true
  }
  const url = URL.createObjectURL(file.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}
