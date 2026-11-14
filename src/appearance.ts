import { ref, watch } from 'vue'

type ThemePreference = 'system' | 'light' | 'dark'

const storageKey = 'insp.themePreference'
const accentKey = 'insp.accentColor'
export const themePreference = ref<ThemePreference>('system')
export const accentColor = ref('#54d81b')

let initialized = false
let systemTheme: MediaQueryList

function applyTheme() {
  const theme = themePreference.value === 'system'
    ? systemTheme.matches ? 'dark' : 'light'
    : themePreference.value
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  applyAccent(theme === 'dark')
  window.dispatchEvent(new CustomEvent('insp:theme', { detail: { dark: theme === 'dark' } }))
}

function blend(color: string, background: string, ratio: number) {
  const channels = [1, 3, 5].map(index => Math.round(
    parseInt(color.slice(index, index + 2), 16) * ratio +
    parseInt(background.slice(index, index + 2), 16) * (1 - ratio),
  ))
  return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function applyAccent(dark: boolean) {
  const color = accentColor.value
  const style = document.documentElement.style
  const background = dark ? '#171b17' : '#ffffff'
  const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)).join(', ')
  style.setProperty('--user-accent', color)
  style.setProperty('--brand', color)
  style.setProperty('--brand-rgb', rgb)
  style.setProperty('--brand-strong', blend(color, dark ? '#ffffff' : '#000000', dark ? .64 : .56))
  style.setProperty('--brand-soft', blend(color, background, dark ? .16 : .14))
  style.setProperty('--brand-tint', blend(color, background, dark ? .10 : .07))
  style.setProperty('--brand-border', blend(color, background, dark ? .32 : .36))
  style.setProperty('--brand-line', blend(color, background, dark ? .56 : .64))
  style.setProperty('--primary-bg', dark ? blend(color, '#171b17', .38) : color)
  style.setProperty('--primary-hover', dark ? blend(color, '#171b17', .52) : blend(color, '#ffffff', .78))
  style.setProperty('--sidebar-bg', blend(color, dark ? '#171b17' : '#ffffff', dark ? .08 : .10))
  style.setProperty('--app-bg', blend(color, dark ? '#111610' : '#ffffff', dark ? .025 : .035))
}

export function setAccentColor(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return
  accentColor.value = color
  localStorage.setItem(accentKey, color)
  applyAccent(document.documentElement.dataset.theme === 'dark')
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
  const savedAccent = localStorage.getItem(accentKey)
  if (savedAccent && /^#[0-9a-f]{6}$/i.test(savedAccent)) accentColor.value = savedAccent
  if (saved === 'system' || saved === 'light' || saved === 'dark') {
    themePreference.value = saved
  }

  systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  systemTheme.addEventListener('change', applyTheme)
  watch(themePreference, applyTheme, { flush: 'sync' })
  applyTheme()

}
