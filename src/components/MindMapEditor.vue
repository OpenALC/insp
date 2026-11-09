<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, CornerUpLeft, ListTree, MoreHorizontal, Network, Plus, RotateCcw, Trash2, ZoomIn, ZoomOut } from 'lucide-vue-next'
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

const NODE_WIDTH = 184
const NODE_HEIGHT = 88
const HORIZONTAL_STEP = 244
const VERTICAL_STEP = 112
const CANVAS_MARGIN = 24

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
const editorElement = ref<HTMLElement>()
const selectedId = ref(props.content.root.id)
const moreActionsOpen = ref(false)
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
    if (!findNode(content.root, selectedId.value)) selectedId.value = content.root.id
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

const selected = computed(() => {
  const location = findNode(documentState.value.root, selectedId.value)!
  const index = location.parent?.children.findIndex(child => child.id === location.node.id) ?? 0
  return { ...location, index, canOutdent: !!location.parent && location.parent.id !== documentState.value.root.id }
})

function selectNode(id: string) {
  if (selectedId.value !== id) moreActionsOpen.value = false
  selectedId.value = id
}

async function revealSelection(focus = false) {
  await nextTick()
  const field = editorElement.value?.querySelector<HTMLTextAreaElement>(`[data-mindmap-node-id="${CSS.escape(selectedId.value)}"]`)
  if (focus) {
    field?.focus({ preventScroll: true })
    field?.select()
  }
  field?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function switchView(mode: ViewMode) {
  viewMode.value = mode
  void revealSelection()
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
  selectNode(child.id)
  void revealSelection(true)
}

function addSibling(id: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const index = target.parent.children.findIndex((child) => child.id === id)
  if (index < 0) return
  const sibling: MindMapNode = { id: crypto.randomUUID(), text: '新主题', children: [] }
  target.parent.children.splice(index + 1, 0, sibling)
  publish(next)
  selectNode(sibling.id)
  void revealSelection(true)
}

function deleteNode(id: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const index = target.parent.children.findIndex((child) => child.id === id)
  if (index < 0) return
  target.parent.children.splice(index, 1)
  selectNode(target.parent.id)
  publish(next)
  void revealSelection()
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
  void revealSelection()
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
  const nextCollapsed = new Set(collapsedIds.value)
  nextCollapsed.delete(newParent.id)
  collapsedIds.value = nextCollapsed
  publish(next)
  void revealSelection()
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
  void revealSelection()
}

function toggleCollapse(id: string) {
  const next = new Set(collapsedIds.value)
  if (next.has(id)) next.delete(id)
  else {
    next.add(id)
    const target = findNode(documentState.value.root, id)!
    if (findNode(target.node, selectedId.value)) selectNode(id)
  }
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

function handleTreeText(id: string, event: Event) {
  updateText(id, (event.target as HTMLTextAreaElement).value)
}

</script>

<template>
  <section ref="editorElement" class="mindmap-editor" :data-editable="editable" aria-label="思维笔记编辑器">
    <header class="mindmap-header">
      <div class="mindmap-heading"><strong>思维笔记</strong><span>{{ nodeCount }} 个主题</span></div>
      <div class="mindmap-mode-switch" role="group" aria-label="思维笔记视图">
        <button type="button" :aria-pressed="viewMode === 'outline'" :class="{ active: viewMode === 'outline' }" @click="switchView('outline')"><ListTree :size="16" />列表</button>
        <button type="button" :aria-pressed="viewMode === 'tree'" :class="{ active: viewMode === 'tree' }" @click="switchView('tree')"><Network :size="16" />思维树</button>
      </div>
    </header>

    <div v-if="viewMode === 'outline'" class="mindmap-outline-viewport">
      <ul class="mindmap-outline-tree" role="tree" aria-label="思维笔记主题列表">
        <MindMapOutlineNode
          :node="documentState.root"
          :depth="0"
          :editable="editable"
          :selected-id="selectedId"
          :collapsed-ids="collapsedIds"
          @select="selectNode"
          @edit="updateText"
          @toggle-collapse="toggleCollapse"
        />
      </ul>
      <p class="mindmap-outline-hint">点按主题书写，在下方添加分支或调整层级。</p>
    </div>

    <template v-else>
      <div class="mindmap-tree-navigation">
        <span>滑动画布查看分支</span>
        <div class="mindmap-zoom-controls" role="group" aria-label="思维树缩放">
          <button type="button" :disabled="zoom <= 0.55" aria-label="缩小" title="缩小" @click="adjustZoom(-0.15)"><ZoomOut :size="16" /></button>
          <button class="mindmap-zoom-reset" type="button" aria-label="恢复默认缩放" title="恢复默认缩放" @click="zoom = 1"><RotateCcw :size="13" /><span>{{ Math.round(zoom * 100) }}%</span></button>
          <button type="button" :disabled="zoom >= 1.6" aria-label="放大" title="放大" @click="adjustZoom(0.15)"><ZoomIn :size="16" /></button>
        </div>
      </div>
      <div class="mindmap-tree-viewport" role="region" aria-label="思维树画布，可上下左右滚动" tabindex="0">
        <div class="mindmap-tree-scaled" :style="scaledCanvasStyle">
          <div class="mindmap-tree-canvas" :style="treeCanvasStyle">
            <svg class="mindmap-tree-links" :width="treeLayout.width" :height="treeLayout.height" aria-hidden="true">
              <path v-for="link in treeLayout.links" :key="link.id" :d="link.path" />
            </svg>
            <div
              v-for="entry in treeLayout.nodes"
              :key="entry.node.id"
              class="mindmap-tree-node"
              :class="{ 'mindmap-tree-node-root': entry.depth === 0, 'is-selected': selectedId === entry.node.id }"
              :style="{ left: `${entry.x}px`, top: `${entry.y}px`, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }"
              role="group"
              :aria-label="entry.depth === 0 ? '中心主题' : `第 ${entry.depth} 层分支`"
              @click="selectNode(entry.node.id)"
            >
              <textarea
                class="mindmap-tree-text"
                :value="entry.node.text"
                rows="3"
                :readonly="!editable"
                :aria-label="entry.depth === 0 ? '中心主题内容' : `第 ${entry.depth} 层分支内容`"
                :data-mindmap-node-id="entry.node.id"
                spellcheck="true"
                @focus="selectNode(entry.node.id)"
                @input="handleTreeText(entry.node.id, $event)"
              ></textarea>
              <button
                v-if="entry.node.children.length"
                class="mindmap-tree-fold"
                type="button"
                :aria-label="collapsedIds.has(entry.node.id) ? `展开 ${entry.node.children.length} 个子主题` : '折叠子主题'"
                :aria-expanded="!collapsedIds.has(entry.node.id)"
                @click.stop="toggleCollapse(entry.node.id)"
              >
                <span v-if="collapsedIds.has(entry.node.id)">{{ entry.node.children.length }}</span>
                <ChevronRight v-if="collapsedIds.has(entry.node.id)" :size="14" />
                <ChevronDown v-else :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-if="editable" class="mindmap-context-tools" role="group" :aria-label="`当前主题：${selected.node.text || '未命名主题'}`">
      <div class="mindmap-current-topic"><span>{{ selected.parent ? '当前分支' : '中心主题' }}</span><strong>{{ selected.node.text || '未命名主题' }}</strong></div>
      <div class="mindmap-primary-tools">
        <button type="button" class="mindmap-insert-child" @pointerdown.prevent @click="addChild(selectedId)"><Plus :size="17" />子主题</button>
        <button type="button" :disabled="!selected.parent" @pointerdown.prevent @click="addSibling(selectedId)"><Plus :size="17" />同级主题</button>
        <button type="button" :aria-expanded="moreActionsOpen" aria-label="更多主题操作" @pointerdown.prevent @click="moreActionsOpen = !moreActionsOpen"><MoreHorizontal :size="20" /><span>更多</span></button>
      </div>
      <div v-if="moreActionsOpen" class="mindmap-more-tools" role="group" aria-label="调整当前主题">
        <button type="button" :disabled="!selected.parent || selected.index === 0" @pointerdown.prevent @click="moveSibling(selectedId, -1)"><ArrowUp :size="16" />上移</button>
        <button type="button" :disabled="!selected.parent || selected.index === selected.parent.children.length - 1" @pointerdown.prevent @click="moveSibling(selectedId, 1)"><ArrowDown :size="16" />下移</button>
        <button type="button" :disabled="!selected.parent || selected.index === 0" @pointerdown.prevent @click="indentNode(selectedId)"><CornerDownRight :size="16" />增加缩进</button>
        <button type="button" :disabled="!selected.canOutdent" @pointerdown.prevent @click="outdentNode(selectedId)"><CornerUpLeft :size="16" />减少缩进</button>
        <button type="button" class="mindmap-delete-topic" :disabled="!selected.parent" title="删除主题及其子主题" @pointerdown.prevent @click="deleteNode(selectedId)"><Trash2 :size="16" />删除分支</button>
      </div>
    </div>
  </section>
</template>
