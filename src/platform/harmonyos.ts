import type { Attachment } from '../domain/models'
import { createNativeAdapter, readImageBytes, type NativeInvoke } from './native'

/** ArkWeb host implements this contract; this is not a HarmonyOS runtime yet. */
export interface HarmonyHostBridge {
  request(command: string, argsJson: string): Promise<string>
  resolveAsset(path: string): string
  onBeforeClose(listener: () => Promise<boolean>): Promise<() => void>
}

export function createHarmonyAdapter(host: HarmonyHostBridge) {
  const invoke: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>) =>
    JSON.parse(await host.request(command, JSON.stringify(args ?? {}))) as T
  return createNativeAdapter(invoke, (path) => host.resolveAsset(path), 'harmonyos', async (file) =>
    invoke<Attachment>('import_image', { originalName: file.name, bytes: Array.from(await readImageBytes(file)) }),
  )
}

export function registerHarmonyCloseGuard(
  host: HarmonyHostBridge,
  save: () => Promise<void>,
  onError: (error: unknown) => void,
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
