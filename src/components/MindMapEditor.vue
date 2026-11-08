<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, CornerUpLeft, ListTree, Network, Plus, RotateCcw, Trash2, ZoomIn, ZoomOut } from 'lucide-vue-next'
import type { MindMapDocument, MindMapNode } from '../domain/mindmap'
import { mindMapText } from '../domain/mindmap'
import MindMapOutlineNode from './MindMapOutlineNode.vue'
import '../mindmap.css'

const props = defineProps<{
  content: MindMapDocument
  editable: boolean
}>()

const emit = defineEmits<{
  'update:document': [content: MindMapDocument, plainText: string]
}>()

type ViewMode = 'outline' | 'tree'

interface PositionedNode {
  node: MindMapNode
  parentId: string | null
  depth: number
  index: number
  siblingCount: number
  x: number
  y: number
  centerY: number
}

const NODE_WIDTH = 260
const NODE_HEIGHT = 114
const HORIZONTAL_STEP = 310
const VERTICAL_STEP = 142
const CANVAS_MARGIN = 34

function cloneNode(node: MindMapNode): MindMapNode {
  return { id: node.id, text: node.text, children: node.children.map(cloneNode) }
}

function cloneDocument(document: MindMapDocument): MindMapDocument {
  return { type: 'mindmap', root: cloneNode(document.root) }
}

const documentState = ref(cloneDocument(props.content))
const viewMode = ref<ViewMode>('outline')
const collapsedIds = ref(new Set<string>())
const zoom = ref(1)
let lastEmittedJson = ''

watch(
  () => props.content,
  (content) => {
    const incomingJson = JSON.stringify(content)
    if (incomingJson === lastEmittedJson) {
      lastEmittedJson = ''
      return
    }
    lastEmittedJson = ''
    documentState.value = cloneDocument(content)
  },
  { deep: true },
)

function publish(document: MindMapDocument) {
  documentState.value = document
  lastEmittedJson = JSON.stringify(document)
  emit('update:document', document, mindMapText(document))
}

function findNode(root: MindMapNode, id: string, parent: MindMapNode | null = null): { node: MindMapNode; parent: MindMapNode | null } | null {
  if (root.id === id) return { node: root, parent }
  for (const child of root.children) {
    const result = findNode(child, id, root)
    if (result) return result
  }
  return null
}

function updateText(id: string, text: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target) return
  target.node.text = text
  publish(next)
}

function addChild(id: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target) return
  const child: MindMapNode = { id: crypto.randomUUID(), text: '新主题', children: [] }
  target.node.children.push(child)
  const nextCollapsed = new Set(collapsedIds.value)
  nextCollapsed.delete(id)
  collapsedIds.value = nextCollapsed
  publish(next)
}

function addSibling(id: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const index = target.parent.children.findIndex((child) => child.id === id)
  if (index < 0) return
  target.parent.children.splice(index + 1, 0, { id: crypto.randomUUID(), text: '新主题', children: [] })
  publish(next)
}

function deleteNode(id: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const index = target.parent.children.findIndex((child) => child.id === id)
  if (index < 0) return
  target.parent.children.splice(index, 1)
  publish(next)
}

function moveSibling(id: string, direction: -1 | 1) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const siblings = target.parent.children
  const index = siblings.findIndex((child) => child.id === id)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= siblings.length) return
  const neighbor = siblings[destination]
  siblings[destination] = target.node
  siblings[index] = neighbor
  publish(next)
}

function indentNode(id: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const siblings = target.parent.children
  const index = siblings.findIndex((child) => child.id === id)
  if (index <= 0) return
  const newParent = siblings[index - 1]
  siblings.splice(index, 1)
  newParent.children.push(target.node)
  publish(next)
}

function outdentNode(id: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const parentLocation = findNode(next.root, target.parent.id)
  const grandparent = parentLocation?.parent
  if (!grandparent) return
  const siblings = target.parent.children
  const index = siblings.findIndex((child) => child.id === id)
  const parentIndex = grandparent.children.findIndex((child) => child.id === target.parent?.id)
  if (index < 0 || parentIndex < 0) return
  siblings.splice(index, 1)
  grandparent.children.splice(parentIndex + 1, 0, target.node)
  publish(next)
}

function toggleCollapse(id: string) {
  const next = new Set(collapsedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedIds.value = next
}

const nodeCount = computed(() => {
  const count = (node: MindMapNode): number => 1 + node.children.reduce((total, child) => total + count(child), 0)
  return count(documentState.value.root)
})

const treeLayout = computed(() => {
  const nodes: PositionedNode[] = []
  let leafIndex = 0
  let maxDepth = 0

  function place(node: MindMapNode, parentId: string | null, depth: number, index: number, siblingCount: number): PositionedNode {
    maxDepth = Math.max(maxDepth, depth)
    const positioned: PositionedNode = {
      node,
      parentId,
      depth,
      index,
      siblingCount,
      x: CANVAS_MARGIN + depth * HORIZONTAL_STEP,
      y: 0,
      centerY: 0,
    }
    nodes.push(positioned)
    const children = collapsedIds.value.has(node.id) ? [] : node.children
    const childPositions = children.map((child, childIndex) => place(child, node.id, depth + 1, childIndex, children.length))
    positioned.centerY = childPositions.length
      ? childPositions.reduce((total, child) => total + child.centerY, 0) / childPositions.length
      : CANVAS_MARGIN + leafIndex++ * VERTICAL_STEP + NODE_HEIGHT / 2
    positioned.y = positioned.centerY - NODE_HEIGHT / 2
    return positioned
  }

  place(documentState.value.root, null, 0, 0, 1)
  const height = Math.max(210, CANVAS_MARGIN * 2 + Math.max(1, leafIndex) * VERTICAL_STEP)
  const width = CANVAS_MARGIN * 2 + maxDepth * HORIZONTAL_STEP + NODE_WIDTH
  const byId = new Map(nodes.map((positioned) => [positioned.node.id, positioned]))
  const links = nodes.flatMap((child) => {
    if (!child.parentId) return []
    const parent = byId.get(child.parentId)
    if (!parent) return []
    const fromX = parent.x + NODE_WIDTH
    const fromY = parent.centerY
    const toX = child.x
    const toY = child.centerY
    const bendX = (fromX + toX) / 2
    return [{ id: child.node.id, path: `M ${fromX} ${fromY} C ${bendX} ${fromY}, ${bendX} ${toY}, ${toX} ${toY}` }]
  })
  return { nodes, links, width, height }
})

const scaledCanvasStyle = computed(() => ({
  width: `${treeLayout.value.width * zoom.value}px`,
  height: `${treeLayout.value.height * zoom.value}px`,
}))

const treeCanvasStyle = computed(() => ({
  width: `${treeLayout.value.width}px`,
  height: `${treeLayout.value.height}px`,
  transform: `scale(${zoom.value})`,
}))

function adjustZoom(delta: number) {
  zoom.value = Math.min(1.6, Math.max(0.55, Math.round((zoom.value + delta) * 100) / 100))
}

function textRows(text: string) {
  return Math.min(4, Math.max(2, text.split('\n').length))
}

function handleTreeText(id: string, event: Event) {
  updateText(id, (event.target as HTMLTextAreaElement).value)
}

async function awaitPendingImports() {}

defineExpose({ awaitPendingImports })
</script>

<template>
  <section class="mindmap-editor" aria-label="思维导图编辑器">
    <header class="mindmap-header">
      <div class="mindmap-heading">
        <span class="mindmap-heading-mark" aria-hidden="true"><Network :size="16" /></span>
        <div>
          <strong>思维导图</strong>
          <span>{{ nodeCount }} 个主题</span>
        </div>
      </div>

      <div class="mindmap-header-actions">
        <div class="mindmap-mode-switch" role="tablist" aria-label="思维导图视图">
          <button type="button" role="tab" :aria-selected="viewMode === 'outline'" :class="{ active: viewMode === 'outline' }" @click="viewMode = 'outline'"><ListTree :size="15" />列表</button>
          <button type="button" role="tab" :aria-selected="viewMode === 'tree'" :class="{ active: viewMode === 'tree' }" @click="viewMode = 'tree'"><Network :size="15" />思维树</button>
        </div>

        <div v-if="viewMode === 'tree'" class="mindmap-zoom-controls" role="toolbar" aria-label="思维树缩放">
          <button type="button" :disabled="zoom <= 0.55" aria-label="缩小" title="缩小" @click="adjustZoom(-0.15)"><ZoomOut :size="15" /></button>
          <span>{{ Math.round(zoom * 100) }}%</span>
          <button type="button" :disabled="zoom >= 1.6" aria-label="放大" title="放大" @click="adjustZoom(0.15)"><ZoomIn :size="15" /></button>
          <button type="button" aria-label="恢复默认缩放" title="恢复默认缩放" @click="zoom = 1"><RotateCcw :size="14" /></button>
        </div>

        <button class="mindmap-add-root-child" type="button" :disabled="!editable" @click="addChild(documentState.root.id)"><Plus :size="15" />添加主题</button>
      </div>
    </header>

    <div v-if="viewMode === 'outline'" class="mindmap-outline-viewport">
      <ul class="mindmap-outline-tree" role="tree" aria-label="思维导图主题列表">
        <MindMapOutlineNode
          :node="documentState.root"
          :parent-id="null"
          :depth="0"
          :index="0"
          :sibling-count="1"
          :editable="editable"
          :collapsed-ids="collapsedIds"
          @edit="updateText"
          @add-child="addChild"
          @add-sibling="addSibling"
          @delete="deleteNode"
          @indent="indentNode"
          @outdent="outdentNode"
          @move-up="moveSibling($event, -1)"
          @move-down="moveSibling($event, 1)"
          @toggle-collapse="toggleCollapse"
        />
      </ul>
      <p class="mindmap-outline-hint">使用主题右侧的按钮添加、排序或调整层级；切换视图不会改变内容。</p>
    </div>

    <div v-else class="mindmap-tree-viewport" role="region" aria-label="思维树视图" tabindex="0">
      <div class="mindmap-tree-scaled" :style="scaledCanvasStyle">
        <div class="mindmap-tree-canvas" :style="treeCanvasStyle">
          <svg class="mindmap-tree-links" :width="treeLayout.width" :height="treeLayout.height" aria-hidden="true">
            <path v-for="link in treeLayout.links" :key="link.id" :d="link.path" />
          </svg>

          <div
            v-for="entry in treeLayout.nodes"
            :key="entry.node.id"
            class="mindmap-tree-node"
            :class="{ 'mindmap-tree-node-root': entry.depth === 0 }"
            :style="{ left: `${entry.x}px`, top: `${entry.y}px`, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }"
            role="group"
            :aria-label="`第 ${entry.depth + 1} 层主题`"
          >
            <textarea
              class="mindmap-tree-text"
              :value="entry.node.text"
              :rows="textRows(entry.node.text)"
              :readonly="!editable"
              :aria-label="`第 ${entry.depth + 1} 层主题内容`"
              :data-mindmap-node-id="entry.node.id"
              spellcheck="true"
              @input="handleTreeText(entry.node.id, $event)"
            ></textarea>

            <div class="mindmap-tree-actions" :aria-label="`第 ${entry.depth + 1} 层主题操作`">
              <button v-if="entry.node.children.length" class="mindmap-action-button" type="button" :aria-label="collapsedIds.has(entry.node.id) ? '展开子主题' : '折叠子主题'" :title="collapsedIds.has(entry.node.id) ? '展开子主题' : '折叠子主题'" :aria-expanded="!collapsedIds.has(entry.node.id)" @click="toggleCollapse(entry.node.id)"><ChevronRight v-if="collapsedIds.has(entry.node.id)" :size="13" /><ChevronDown v-else :size="13" /></button>
              <button class="mindmap-action-button" type="button" :disabled="!editable" aria-label="添加子主题" title="添加子主题" @click="addChild(entry.node.id)"><Plus :size="13" /></button>
              <button v-if="entry.parentId" class="mindmap-action-button" type="button" :disabled="!editable" aria-label="添加同级主题" title="添加同级主题" @click="addSibling(entry.node.id)"><Plus :size="13" /></button>
              <button v-if="entry.parentId" class="mindmap-action-button" type="button" :disabled="!editable || entry.index === 0" aria-label="上移一级" title="上移一级" @click="moveSibling(entry.node.id, -1)"><ArrowUp :size="13" /></button>
              <button v-if="entry.parentId" class="mindmap-action-button" type="button" :disabled="!editable || entry.index === entry.siblingCount - 1" aria-label="下移一级" title="下移一级" @click="moveSibling(entry.node.id, 1)"><ArrowDown :size="13" /></button>
              <button v-if="entry.parentId" class="mindmap-action-button" type="button" :disabled="!editable || entry.index === 0" aria-label="缩进主题" title="缩进主题" @click="indentNode(entry.node.id)"><CornerDownRight :size="13" /></button>
              <button v-if="entry.parentId" class="mindmap-action-button" type="button" :disabled="!editable || entry.depth <= 1" aria-label="减少缩进" title="减少缩进" @click="outdentNode(entry.node.id)"><CornerUpLeft :size="13" /></button>
              <button v-if="entry.parentId" class="mindmap-action-button mindmap-action-danger" type="button" :disabled="!editable" aria-label="删除主题及其子主题" title="删除主题及其子主题" @click="deleteNode(entry.node.id)"><Trash2 :size="13" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
