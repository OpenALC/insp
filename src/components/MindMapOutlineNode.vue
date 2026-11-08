<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, CornerUpLeft, Plus, Trash2 } from 'lucide-vue-next'
import type { MindMapNode } from '../domain/mindmap'

defineOptions({ name: 'MindMapOutlineNode' })

const props = defineProps<{
  node: MindMapNode
  parentId: string | null
  depth: number
  index: number
  siblingCount: number
  editable: boolean
  collapsedIds: Set<string>
}>()

const emit = defineEmits<{
  edit: [id: string, text: string]
  'add-child': [id: string]
  'add-sibling': [id: string]
  delete: [id: string]
  indent: [id: string]
  outdent: [id: string]
  'move-up': [id: string]
  'move-down': [id: string]
  'toggle-collapse': [id: string]
}>()

const rows = computed(() => Math.min(8, Math.max(2, props.node.text.split('\n').length)))
const collapsed = computed(() => props.collapsedIds.has(props.node.id))

function forwardEdit(id: string, text: string) {
  emit('edit', id, text)
}

function forwardAddChild(id: string) {
  emit('add-child', id)
}

function forwardAddSibling(id: string) {
  emit('add-sibling', id)
}

function forwardDelete(id: string) {
  emit('delete', id)
}

function forwardIndent(id: string) {
  emit('indent', id)
}

function forwardOutdent(id: string) {
  emit('outdent', id)
}

function forwardMoveUp(id: string) {
  emit('move-up', id)
}

function forwardMoveDown(id: string) {
  emit('move-down', id)
}

function forwardToggleCollapse(id: string) {
  emit('toggle-collapse', id)
}

function editText(event: Event) {
  emit('edit', props.node.id, (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <li
    class="mindmap-outline-item"
    role="treeitem"
    :aria-level="depth + 1"
    :aria-expanded="node.children.length ? !collapsed : undefined"
  >
    <div class="mindmap-outline-row" :class="{ 'mindmap-outline-row-root': depth === 0 }">
      <button
        v-if="node.children.length"
        class="mindmap-collapse-button"
        type="button"
        :aria-label="collapsed ? '展开子主题' : '折叠子主题'"
        :title="collapsed ? '展开子主题' : '折叠子主题'"
        :aria-expanded="!collapsed"
        @click="emit('toggle-collapse', node.id)"
      >
        <ChevronRight v-if="collapsed" :size="15" />
        <ChevronDown v-else :size="15" />
      </button>
      <span v-else class="mindmap-outline-marker" aria-hidden="true"></span>

      <textarea
        class="mindmap-outline-text"
        :value="node.text"
        :rows="rows"
        :readonly="!editable"
        :aria-label="`第 ${depth + 1} 层主题内容`"
        :data-mindmap-node-id="node.id"
        spellcheck="true"
        @input="editText"
      ></textarea>

      <div class="mindmap-outline-actions" :aria-label="`第 ${depth + 1} 层主题操作`">
        <button class="mindmap-action-button" type="button" :disabled="!editable" aria-label="添加子主题" title="添加子主题" @click="emit('add-child', node.id)"><Plus :size="14" /></button>
        <button v-if="parentId" class="mindmap-action-button" type="button" :disabled="!editable" aria-label="添加同级主题" title="添加同级主题" @click="emit('add-sibling', node.id)"><Plus :size="14" /></button>
        <button v-if="parentId" class="mindmap-action-button" type="button" :disabled="!editable || index === 0" aria-label="上移一级" title="上移一级" @click="emit('move-up', node.id)"><ArrowUp :size="14" /></button>
        <button v-if="parentId" class="mindmap-action-button" type="button" :disabled="!editable || index === siblingCount - 1" aria-label="下移一级" title="下移一级" @click="emit('move-down', node.id)"><ArrowDown :size="14" /></button>
        <button v-if="parentId" class="mindmap-action-button" type="button" :disabled="!editable || index === 0" aria-label="缩进主题" title="缩进主题" @click="emit('indent', node.id)"><CornerDownRight :size="14" /></button>
        <button v-if="parentId" class="mindmap-action-button" type="button" :disabled="!editable || depth <= 1" aria-label="减少缩进" title="减少缩进" @click="emit('outdent', node.id)"><CornerUpLeft :size="14" /></button>
        <button v-if="parentId" class="mindmap-action-button mindmap-action-danger" type="button" :disabled="!editable" aria-label="删除主题及其子主题" title="删除主题及其子主题" @click="emit('delete', node.id)"><Trash2 :size="14" /></button>
      </div>
    </div>

    <ul v-if="node.children.length && !collapsed" class="mindmap-outline-group" role="group">
      <MindMapOutlineNode
        v-for="(child, childIndex) in node.children"
        :key="child.id"
        :node="child"
        :parent-id="node.id"
        :depth="depth + 1"
        :index="childIndex"
        :sibling-count="node.children.length"
        :editable="editable"
        :collapsed-ids="collapsedIds"
        @edit="forwardEdit"
        @add-child="forwardAddChild"
        @add-sibling="forwardAddSibling"
        @delete="forwardDelete"
        @indent="forwardIndent"
        @outdent="forwardOutdent"
        @move-up="forwardMoveUp"
        @move-down="forwardMoveDown"
        @toggle-collapse="forwardToggleCollapse"
      />
    </ul>
  </li>
</template>
