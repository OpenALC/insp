<script setup lang="ts">
import { initializeTheme, setThemePreference, themePreference } from '../appearance'
import SettingsChoice from './SettingsChoice.vue'

initializeTheme()

function changeTheme(value: string) {
  setThemePreference(value as typeof themePreference.value)
}
</script>

<template>
  <SettingsChoice label="外观" :value="themePreference" :options="[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]" @change="changeTheme" />
</template>
