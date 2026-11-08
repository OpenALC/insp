import { createTauriAdapter } from './tauri'

export const platform = createTauriAdapter(import.meta.env.TAURI_ENV_PLATFORM === 'android' ? 'android' : 'windows')
export { registerCloseGuard } from './tauri'
