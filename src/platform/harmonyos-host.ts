export interface HarmonyNativeProxy {
  postMessage(requestJson: string): void
}

interface HarmonyResponseEnvelope {
  id: string
  result?: string
  error?: string
}

type PendingRequest = {
  resolve: (resultJson: string) => void
  reject: (error: Error) => void
}

declare global {
  interface Window {
    inspNative: HarmonyNativeProxy
    __inspBridgeResponse: (responseJson: string) => void
    __inspBeforeClose: () => Promise<boolean>
  }
}

const harmonyOrigin = 'https://insp.local'

export function createHarmonyHost() {
  let nextId = 0
  const pending = new Map<string, PendingRequest>()
  const closeListeners = new Set<() => Promise<boolean>>()

  window.__inspBridgeResponse = (responseJson: string): void => {
    const response = JSON.parse(responseJson) as HarmonyResponseEnvelope
    const request = pending.get(response.id)
    if (request === undefined) return
    pending.delete(response.id)
    if (response.error !== undefined) {
      request.reject(new Error(response.error))
    } else {
      request.resolve(response.result ?? 'null')
    }
  }

  window.__inspBeforeClose = async (): Promise<boolean> => {
    for (const listener of closeListeners) {
      if (!(await listener())) return false
    }
    return true
  }

  return {
    request(command: string, argsJson: string): Promise<string> {
      const id = String(++nextId)
      const requestJson = JSON.stringify({ id, command, args: JSON.parse(argsJson) as Record<string, unknown> })
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        window.inspNative.postMessage(requestJson)
      })
    },
    resolveAsset(path: string): string {
      return new URL(path, harmonyOrigin + '/').toString()
    },
    async onBeforeClose(listener: () => Promise<boolean>): Promise<() => void> {
      closeListeners.add(listener)
      return (): void => {
        closeListeners.delete(listener)
      }
    }
  };
}
