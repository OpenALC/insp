<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, Plus, RotateCcw, ZoomIn, ZoomOut } from 'lucide-vue-next'
import type { MindMapDocument, MindMapNode } from '../domain/mindmap'
import { mindMapText, UNTITLED_MIND_MAP } from '../domain/mindmap'
import MindMapOutlineNode from './MindMapOutlineNode.vue'
import MindMapNodeField from './MindMapNodeField.vue'
import MindMapNodeTools from './MindMapNodeTools.vue'
import { changeHierarchy } from '../domain/mindmap-structure'
import { MAX_CONTENT_ZOOM, MIN_CONTENT_ZOOM, useContentZoom } from '../content-zoom'
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

const NODE_WIDTH = 160
const NODE_HEIGHT = 68
const HORIZONTAL_STEP = 228
const VERTICAL_STEP = 104
const CANVAS_MARGIN = 42

function cloneNode(node: MindMapNode): MindMapNode {
  return { id: node.id, text: node.text, children: node.children.map(cloneNode) }
}

function cloneDocument(document: MindMapDocument): MindMapDocument {
  return { type: 'mindmap', root: cloneNode(document.root) }
}

const documentState = ref(cloneDocument(props.content))
const viewMode = ref<ViewMode>('outline')
const collapsedIds = ref(new Set<string>())
const zoomByView = reactive({ outline: 1, tree: 1 })
const zoom = computed({
  get: () => zoomByView[viewMode.value],
  set: (value: number) => { zoomByView[viewMode.value] = value },
})
const editorElement = ref<HTMLElement>()
const selectedId = ref(props.content.root.id)
const viewport = ref<HTMLElement>()
const contentSurface = ref<HTMLElement>()
const scrollPositions = { outline: [0, 0], tree: [0, 0] }
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
  selectedId.value = id
}

async function revealSelection(focus = false) {
  await nextTick()
  const field = selectedField()
  if (focus) {
    field?.focus({ preventScroll: true })
    field?.select()
  }
  field?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function selectedField() {
  return editorElement.value?.querySelector<HTMLTextAreaElement>(`[data-mindmap-node-id="${CSS.escape(selectedId.value)}"]`)
}

function caret() {
  const field = selectedField()
  return field && document.activeElement === field ? [field.selectionStart, field.selectionEnd, field.selectionDirection] as const : null
}

function finishPendingInput() {
  const field = selectedField()
  if (!field || document.activeElement !== field) return
  const fieldText = () => field.value || (selectedId.value === documentState.value.root.id ? UNTITLED_MIND_MAP : '')
  if (fieldText() === selected.value.node.text) return
  // Give the IME a chance to finish before replacing this field with another one.
  field.blur()
  if (fieldText() !== selected.value.node.text) updateText(selectedId.value, fieldText())
}

function animateLabel(target: HTMLElement, origin: DOMRect) {
  const end = target.getBoundingClientRect()
  const scale = zoom.value
  target.animate([{ transform: `translate(${(origin.left - end.left) / scale}px, ${(origin.top - end.top) / scale}px)` }, { transform: 'none' }], { duration: 210, easing: 'cubic-bezier(.2,.8,.2,1)' })
}

async function switchView(mode: ViewMode) {
  if (viewMode.value === mode || !viewport.value) return
  const field = selectedField()
  const origin = field?.getBoundingClientRect()
  const range = caret()
  finishPendingInput()
  scrollPositions[viewMode.value] = [viewport.value.scrollLeft, viewport.value.scrollTop]
  viewMode.value = mode
  await nextTick()
  if (!viewport.value || viewMode.value !== mode) return
  viewport.value.scrollTo(scrollPositions[mode][0], scrollPositions[mode][1])
  const target = selectedField()
  if (!target) return
  if (range) {
    target.focus({ preventScroll: true })
    target.setSelectionRange(...range)
  }
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  if (!origin || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // Translate the label, rather than scaling text or reflowing the graph during animation.
  animateLabel(target, origin)
  viewport.value.animate([{ opacity: .5 }, { opacity: 1 }], { duration: 170 })
}

function updateText(id: string, text: string) {
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target) return
  target.node.text = text
  publish(next)
}

function addChild(id: string) {
  finishPendingInput()
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target) return
  const child: MindMapNode = { id: crypto.randomUUID(), text: '', children: [] }
  target.node.children.push(child)
  const nextCollapsed = new Set(collapsedIds.value)
  nextCollapsed.delete(id)
  collapsedIds.value = nextCollapsed
  publish(next)
  selectNode(child.id)
  void revealSelection(true)
}

function addSibling(id: string) {
  finishPendingInput()
  const next = cloneDocument(documentState.value)
  const target = findNode(next.root, id)
  if (!target?.parent) return
  const index = target.parent.children.findIndex((child) => child.id === id)
  if (index < 0) return
  const sibling: MindMapNode = { id: crypto.randomUUID(), text: '', children: [] }
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

async function adjustHierarchy(id: string, action: 'up' | 'down' | 'indent' | 'outdent') {
  const range = caret()
  const origin = selectedField()?.getBoundingClientRect()
  finishPendingInput()
  const next = changeHierarchy(documentState.value, id, action)
  if (next === documentState.value) return
  const parent = findNode(next.root, id)?.parent
  if (parent) {
    const collapsed = new Set(collapsedIds.value)
    collapsed.delete(parent.id)
    collapsedIds.value = collapsed
  }
  publish(next)
  await revealSelection()
  const field = selectedField()
  if (range) {
    field?.focus({ preventScroll: true })
    field?.setSelectionRange(...range)
  }
  if (field && origin && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) animateLabel(field, origin)
}

function nodeCommand(id: string, action: 'enter' | 'indent' | 'outdent') {
  if (!props.editable) return
  selectNode(id)
  if (action === 'enter') {
    if (id === documentState.value.root.id) addChild(id)
    else addSibling(id)
  } else void adjustHierarchy(id, action)
}

function toolAction(action: 'child' | 'sibling' | 'indent' | 'outdent' | 'up' | 'down' | 'delete') {
  if (action === 'child') addChild(selectedId.value)
  else if (action === 'sibling') addSibling(selectedId.value)
  else if (action === 'delete') deleteNode(selectedId.value)
  else void adjustHierarchy(selectedId.value, action)
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

defineExpose({ viewMode, switchView })

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
  const height = CANVAS_MARGIN * 2 + (leafIndex - 1) * VERTICAL_STEP + NODE_HEIGHT
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

const { extentStyle, surfaceStyle, setZoom } = useContentZoom(viewport, contentSurface, zoom, {
  size: () => viewMode.value === 'tree' ? treeLayout.value : undefined,
})

function adjustZoom(delta: number) {
  void setZoom(Math.round((zoom.value + delta) * 100) / 100)
}

</script>

<template>
  <section ref="editorElement" class="mindmap-editor" :data-editable="editable" aria-label="灵感笔记编辑器">

    <div ref="viewport" v-if="viewMode === 'outline'" class="mindmap-outline-viewport content-zoom-viewport">
      <div class="content-zoom-extent" :style="extentStyle">
        <div ref="contentSurface" class="content-zoom-surface" :style="surfaceStyle">
          <ul class="mindmap-outline-tree" role="tree" aria-label="灵感笔记主题列表">
            <MindMapOutlineNode
              :node="documentState.root"
              :depth="0"
              :editable="editable"
              :selected-id="selectedId"
              :collapsed-ids="collapsedIds"
              @select="selectNode"
              @edit="updateText"
              @command="nodeCommand"
              @toggle-collapse="toggleCollapse"
            />
          </ul>
          <button v-if="!documentState.root.children.length && editable" type="button" class="mindmap-first-topic" @click="addChild(documentState.root.id)">输入第一个分支，回车继续添加</button>
        </div>
      </div>
    </div>

    <template v-else>
      <div class="mindmap-tree-navigation">
        <div class="mindmap-zoom-controls" role="group" aria-label="思维树缩放">
          <button type="button" :disabled="zoom <= MIN_CONTENT_ZOOM" aria-label="缩小" title="缩小" @click="adjustZoom(-0.15)"><ZoomOut :size="16" /></button>
          <button class="mindmap-zoom-reset" type="button" aria-label="恢复默认缩放" title="恢复默认缩放" @click="setZoom(1)"><RotateCcw :size="13" /><span>{{ Math.round(zoom * 100) }}%</span></button>
          <button type="button" :disabled="zoom >= MAX_CONTENT_ZOOM" aria-label="放大" title="放大" @click="adjustZoom(0.15)"><ZoomIn :size="16" /></button>
        </div>
      </div>
      <div ref="viewport" class="mindmap-tree-viewport content-zoom-viewport" role="region" aria-label="思维树画布，可上下左右滚动" tabindex="0">
        <div class="mindmap-tree-scaled content-zoom-extent" :style="extentStyle">
          <div ref="contentSurface" class="mindmap-tree-canvas content-zoom-surface" :style="surfaceStyle">
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
              <MindMapNodeField class="mindmap-tree-text" :id="entry.node.id" :text="entry.node.text" :editable="editable" :root="entry.depth === 0"
                :label="entry.depth === 0 ? '中心主题内容' : `第 ${entry.depth} 层分支内容`" :rows="2"
                @select="selectNode" @edit="updateText" @command="nodeCommand" />
              <button v-if="editable && selectedId === entry.node.id" class="mindmap-tree-add" type="button"
                aria-label="在当前主题旁添加子主题" @pointerdown.prevent @click.stop="addChild(entry.node.id)"><Plus :size="18" /></button>
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

    <MindMapNodeTools v-if="editable" :selected="selected" @action="toolAction" />
  </section>
</template>
