<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import type { MindMapNode } from '../domain/mindmap'
import MindMapNodeField from './MindMapNodeField.vue'

defineOptions({ name: 'MindMapOutlineNode' })

const props = defineProps<{
  node: MindMapNode
  depth: number
  editable: boolean
  selectedId: string
  collapsedIds: Set<string>
}>()

const emit = defineEmits<{
  edit: [id: string, text: string]
  select: [id: string]
  command: [id: string, command: 'enter' | 'indent' | 'outdent']
  'toggle-collapse': [id: string]
}>()

const collapsed = computed(() => props.collapsedIds.has(props.node.id))
</script>

<template>
  <li
    class="mindmap-outline-item"
    role="treeitem"
    :aria-level="depth + 1"
    :aria-selected="selectedId === node.id"
    :aria-expanded="node.children.length ? !collapsed : undefined"
  >
    <div
      class="mindmap-outline-row"
      :class="{ 'mindmap-outline-row-root': depth === 0, 'is-selected': selectedId === node.id }"
      @click="emit('select', node.id)"
    >
      <button
        v-if="node.children.length"
        class="mindmap-collapse-button"
        type="button"
        :aria-label="collapsed ? `展开 ${node.children.length} 个子主题` : '折叠子主题'"
        :aria-expanded="!collapsed"
        @click.stop="emit('toggle-collapse', node.id)"
      >
        <ChevronRight v-if="collapsed" :size="16" />
        <ChevronDown v-else :size="16" />
      </button>
      <span v-else class="mindmap-outline-marker" aria-hidden="true"></span>

      <div class="mindmap-outline-field" :data-text="node.text">
        <MindMapNodeField
          class="mindmap-outline-text"
          :id="node.id"
          :text="node.text"
          :root="depth === 0"
          :editable="editable"
          :label="depth === 0 ? '中心主题内容' : `第 ${depth} 层分支内容`"
          rows="1"
          @select="emit('select', $event)"
          @edit="(id, text) => emit('edit', id, text)"
          @command="(id, command) => emit('command', id, command)"
        />
      </div>
      <span v-if="collapsed && node.children.length" class="mindmap-fold-count" aria-hidden="true">{{ node.children.length }}</span>
    </div>

    <ul v-if="node.children.length && !collapsed" class="mindmap-outline-group" role="group">
      <MindMapOutlineNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :editable="editable"
        :selected-id="selectedId"
        :collapsed-ids="collapsedIds"
        @edit="(id, text) => emit('edit', id, text)"
        @select="emit('select', $event)"
        @command="(id, command) => emit('command', id, command)"
        @toggle-collapse="emit('toggle-collapse', $event)"
      />
    </ul>
  </li>
</template>
