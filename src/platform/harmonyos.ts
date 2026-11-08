import type { Attachment } from '../domain/models'
import { createNativeAdapter, readImageBytes, type NativeInvoke } from './native'
import type { createHarmonyHost } from './harmonyos-host'

export type HarmonyHostBridge = ReturnType<typeof createHarmonyHost>

export function createHarmonyAdapter(host: HarmonyHostBridge) {
  const invoke: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>) =>
    JSON.parse(await host.request(command, JSON.stringify(args ?? {}))) as T
  return createNativeAdapter(
    invoke,
    (path) => host.resolveAsset(path),
    'harmonyos',
    async (file) => invoke<Attachment>('import_image', {
      originalName: file.name,
      bytes: Array.from(await readImageBytes(file))
    })
  )
}

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
