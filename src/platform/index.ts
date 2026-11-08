import { invoke } from '@tauri-apps/api/core'
import { registerCloseGuard as registerTauriCloseGuard } from './tauri'
import { registerHarmonyCloseGuard } from './harmonyos'
import { createHarmonyHost } from './harmonyos-host'
import type { NativeInvoke } from './native'
import { EncryptedWorkspace } from '../security/workspace'

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
