import { ref, watch } from 'vue'

type ThemePreference = 'system' | 'light' | 'dark'

const storageKey = 'insp.themePreference'
export const themePreference = ref<ThemePreference>('system')

let initialized = false
let systemTheme: MediaQueryList

function applyTheme() {
  const theme = themePreference.value === 'system'
    ? systemTheme.matches ? 'dark' : 'light'
    : themePreference.value
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export function setThemePreference(value: ThemePreference) {
  initializeTheme()
  themePreference.value = value
  localStorage.setItem(storageKey, value)
}

export function initializeTheme() {
  if (initialized) return
  initialized = true

  const saved = localStorage.getItem(storageKey)
  if (saved === 'system' || saved === 'light' || saved === 'dark') {
    themePreference.value = saved
  }

  systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  systemTheme.addEventListener('change', applyTheme)
  watch(themePreference, applyTheme, { flush: 'sync' })
  applyTheme()

}
