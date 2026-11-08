<script setup lang="ts">
import { initializeTheme, setThemePreference, themePreference } from '../appearance'

initializeTheme()

function changeTheme(event: Event) {
  setThemePreference((event.target as HTMLSelectElement).value as typeof themePreference.value)
}
</script>

<template>
  <label class="theme-select">
    <span>外观</span>
    <select aria-label="外观模式" :value="themePreference" @change="changeTheme">
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </select>
  </label>
</template>
