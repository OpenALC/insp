import type { createHarmonyHost } from './harmonyos-host'

export type HarmonyHostBridge = ReturnType<typeof createHarmonyHost>

export function registerHarmonyCloseGuard(
  host: HarmonyHostBridge,
  save: () => Promise<void>,
  onError: (error: unknown) => void
) {
  return host.onBeforeClose(async () => {
    try {
      await save()
      return true
    } catch (error) {
      onError(error)
      return false
    }
  })
}
