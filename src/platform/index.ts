import { createTauriAdapter, registerCloseGuard as registerTauriCloseGuard } from './tauri'
import { createHarmonyAdapter, registerHarmonyCloseGuard } from './harmonyos'
import { createHarmonyHost } from './harmonyos-host'

const harmonyHost = 'inspNative' in window ? createHarmonyHost() : null

export const platform = harmonyHost
  ? createHarmonyAdapter(harmonyHost)
  : createTauriAdapter(import.meta.env.TAURI_ENV_PLATFORM === 'android' ? 'android' : 'windows')

export function registerCloseGuard(save: () => Promise<void>, onError: (error: unknown) => void) {
  return harmonyHost
    ? registerHarmonyCloseGuard(harmonyHost, save, onError)
    : registerTauriCloseGuard(save, onError)
}
