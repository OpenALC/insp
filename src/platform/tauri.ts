import { exit, onBackButtonPress } from '@tauri-apps/api/app'
import { listen, TauriEvent } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

const isAndroid = import.meta.env.TAURI_ENV_PLATFORM === 'android'

export async function registerCloseGuard(save: () => Promise<void>, onError: (error: unknown) => void) {
  if (isAndroid) {
    const flushOnLifecycle = () => {
      void save().catch(onError)
    }
    const unlistenSuspended = await listen(TauriEvent.WINDOW_SUSPENDED, flushOnLifecycle)
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flushOnLifecycle()
    }
    document.addEventListener('visibilitychange', flushWhenHidden)
    window.addEventListener('pagehide', flushOnLifecycle)

    const backListener = await onBackButtonPress(() => {
      const backEvent = new Event('insp:back', { cancelable: true })
      if (window.dispatchEvent(backEvent)) {
        void save().then(() => exit(0)).catch(onError)
      }
    })

    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden)
      window.removeEventListener('pagehide', flushOnLifecycle)
      unlistenSuspended()
      void backListener.unregister()
    }
  }

  const desktopWindow = getCurrentWindow()
  return desktopWindow.onCloseRequested(async (event) => {
    event.preventDefault()
    try {
      await save()
      await desktopWindow.destroy()
    } catch (error) {
      onError(error)
    }
  })
}
