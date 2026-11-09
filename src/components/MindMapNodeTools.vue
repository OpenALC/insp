<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { ArrowDown, ArrowUp, CornerDownRight, CornerUpLeft, MoreHorizontal, Plus, Trash2 } from 'lucide-vue-next'
import type { MindMapNode } from '../domain/mindmap'
import type { HierarchyAction } from '../domain/mindmap-structure'

const props = defineProps<{
  selected: {
    node: MindMapNode
    parent: MindMapNode | null
    index: number
    canOutdent: boolean
  }
}>()

type NodeAction = 'child' | 'sibling' | HierarchyAction | 'delete'

const emit = defineEmits<{
  action: [action: NodeAction]
}>()

const moreOpen = ref(false)
const moreButton = ref<HTMLButtonElement>()
const morePanel = ref<HTMLDivElement>()
const moreId = useId()
const canIndent = computed(() => !!props.selected.parent && props.selected.index > 0)
const canMoveDown = computed(() => !!props.selected.parent && props.selected.index < props.selected.parent.children.length - 1)

function closeMore() {
  if (morePanel.value?.contains(document.activeElement)) moreButton.value!.focus({ preventScroll: true })
  moreOpen.value = false
}

function act(action: NodeAction) {
  closeMore()
  emit('action', action)
}

watch(() => props.selected.node.id, closeMore)
</script>

<template>
  <div
    class="node-tools"
    role="group"
    :aria-label="`主题操作：${selected.node.text || '未命名主题'}`"
    @pointerdown.prevent
    @keydown.esc.stop.prevent="closeMore"
  >
    <div class="node-tools__primary" role="group" aria-label="新增主题与调整层级">
      <button
        class="node-tools__button"
        type="button"
        :disabled="!selected.parent || !selected.canOutdent"
        aria-label="升级主题，移到父主题之后"
        title="升级：移到父主题之后"
        @click="act('outdent')"
      >
        <CornerUpLeft :size="18" aria-hidden="true" /><span>升级</span>
      </button>
      <button
        class="node-tools__button"
        type="button"
        :disabled="!canIndent"
        aria-label="降级主题，移到前一主题之下"
        title="降级：成为前一主题的子主题"
        @click="act('indent')"
      >
        <CornerDownRight :size="18" aria-hidden="true" /><span>降级</span>
      </button>
      <button class="node-tools__button" type="button" aria-label="新增子主题" @click="act('child')">
        <Plus :size="18" aria-hidden="true" /><span>子主题</span>
      </button>
      <button class="node-tools__button" type="button" :disabled="!selected.parent" aria-label="新增同级主题" @click="act('sibling')">
        <Plus :size="18" aria-hidden="true" /><span>同级</span>
      </button>
      <button
        ref="moreButton"
        class="node-tools__button"
        type="button"
        aria-label="更多主题操作"
        :aria-expanded="moreOpen"
        :aria-controls="moreId"
        @click="moreOpen = !moreOpen"
      >
        <MoreHorizontal :size="18" aria-hidden="true" /><span>更多</span>
      </button>
    </div>

    <div v-show="moreOpen" :id="moreId" ref="morePanel" class="node-tools__more" role="group" aria-label="移动与删除主题">
      <button class="node-tools__button" type="button" :disabled="!canIndent" aria-label="上移主题" @click="act('up')">
        <ArrowUp :size="18" aria-hidden="true" /><span>上移</span>
      </button>
      <button class="node-tools__button" type="button" :disabled="!canMoveDown" aria-label="下移主题" @click="act('down')">
        <ArrowDown :size="18" aria-hidden="true" /><span>下移</span>
      </button>
      <button
        class="node-tools__button"
        type="button"
        :disabled="!selected.parent"
        aria-label="删除主题及其全部子主题"
        title="删除主题及其全部子主题"
        @click="act('delete')"
      >
        <Trash2 :size="18" aria-hidden="true" /><span>删除分支</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.node-tools {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  padding: 4px 0;
  color: color-mix(in srgb, var(--ink) 86%, var(--paper));
  border-top: 1px solid var(--line);
  background: var(--paper);
  font-family: inherit;
}

.node-tools__primary {
  display: grid;
  grid-template-columns: repeat(5, minmax(44px, 1fr));
  gap: 2px;
}

.node-tools .node-tools__button {
  display: inline-flex;
  min-width: 44px;
  min-height: 48px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  margin: 0;
  padding: 4px;
  color: inherit;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 1.25;
  white-space: nowrap;
  cursor: pointer;
  touch-action: manipulation;
}

.node-tools .node-tools__button:disabled {
  color: inherit;
  -webkit-text-fill-color: currentColor;
  opacity: .35;
  cursor: not-allowed;
}

.node-tools .node-tools__button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -3px;
}

.node-tools .node-tools__button:active:not(:disabled),
.node-tools .node-tools__button[aria-expanded='true'] {
  background: color-mix(in srgb, var(--ink) 8%, var(--paper));
}

.node-tools__more {
  position: absolute;
  z-index: 10;
  right: 0;
  bottom: calc(100% + 4px);
  display: flex;
  gap: 4px;
  max-width: 100%;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
}

.node-tools__more .node-tools__button {
  min-width: 56px;
  padding-inline: 8px;
}

@media (hover: hover) {
  .node-tools .node-tools__button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink) 8%, var(--paper));
  }
}
</style>
