<script setup lang="ts">
import { ref } from 'vue'
import { Check, ChevronRight, LayoutGrid, List, Monitor, Moon, Palette, Sun } from 'lucide-vue-next'

const props = defineProps<{
  label: string
  value: string
  options: { value: string; label: string }[]
}>()
const emit = defineEmits<{ change: [value: string] }>()
const open = ref(false)
function choose(value: string) {
  open.value = false
  emit('change', value)
}
function icon(value: string) {
  return ({ system: Monitor, light: Sun, dark: Moon, grid: LayoutGrid, list: List } as Record<string, typeof Monitor>)[value]
}
</script>

<template>
  <button class="settings-row" type="button" :aria-haspopup="'dialog'" :aria-expanded="open" @click="open = true">
    <Palette v-if="label === '外观'" :size="20" /><LayoutGrid v-else :size="20" />
    <span>{{ label }}</span><span class="settings-value">{{ options.find(option => option.value === value)?.label }}</span><ChevronRight :size="17" />
  </button>
  <Teleport to="body">
    <div v-if="open" class="sheet-backdrop settings-choice-backdrop" @click.self="open = false" @keydown.esc="open = false">
      <section class="bottom-sheet" role="dialog" aria-modal="true" :aria-label="label">
        <div class="sheet-grabber"></div><h2>{{ label }}</h2>
        <button v-for="option in props.options" :key="option.value" class="sheet-action" type="button" @click="choose(option.value)">
          <component :is="icon(option.value)" :size="21" /><span>{{ option.label }}</span><Check v-if="value === option.value" class="choice-check" :size="20" />
        </button>
        <button class="sheet-cancel" type="button" @click="open = false">取消</button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-choice-backdrop { z-index: 1000; }
</style>
