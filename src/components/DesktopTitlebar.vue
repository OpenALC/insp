<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Maximize2, Minus, X } from 'lucide-vue-next'

const window = getCurrentWindow()
</script>

<template>
  <header class="desktop-titlebar">
    <div class="desktop-titlebar-brand" data-tauri-drag-region>拾页 <span>Inspiration</span></div>
    <div class="desktop-titlebar-drag" data-tauri-drag-region @dblclick="window.toggleMaximize()"></div>
    <div class="desktop-window-controls">
      <button type="button" aria-label="最小化" title="最小化" @click="window.minimize()"><Minus :size="16" /></button>
      <button type="button" aria-label="最大化或还原" title="最大化或还原" @click="window.toggleMaximize()"><Maximize2 :size="15" /></button>
      <button type="button" class="desktop-close" aria-label="关闭窗口" title="关闭窗口" @click="window.close()"><X :size="17" /></button>
    </div>
  </header>
</template>
