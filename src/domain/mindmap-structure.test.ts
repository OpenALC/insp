import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isReactive, reactive } from 'vue'
import type { MindMapDocument, MindMapNode } from './mindmap.ts'
import { changeHierarchy, type HierarchyAction } from './mindmap-structure.ts'

const document: MindMapDocument = {
  type: 'mindmap',
  root: {
    id: 'root', text: '中心主题', children: [
      {
        id: 'a', text: '分支 A', children: [
          { id: 'a1', text: '主题 A1', children: [{ id: 'a1x', text: '保留 A1 子树', children: [] }] },
          { id: 'a2', text: '主题 A2', children: [{ id: 'a2x', text: '保留 A2 子树', children: [] }] },
          { id: 'a3', text: '主题 A3', children: [] },
        ],
      },
      {
        id: 'b', text: '分支 B', children: [
          { id: 'b1', text: '主题 B1', children: [{ id: 'b1x', text: '深层主题', children: [] }] },
          { id: 'b2', text: '主题 B2', children: [] },
        ],
      },
      { id: 'c', text: '分支 C', children: [] },
    ],
  },
}

function freezeTree(node: MindMapNode) {
  node.children.forEach(freezeTree)
  Object.freeze(node.children)
  Object.freeze(node)
}

freezeTree(document.root)
Object.freeze(document)

const [a, b, c] = document.root.children
const [a1, a2, a3] = a.children
const [b1, b2] = b.children

test('降级将整棵子树追加到前一主题末尾，保留已有子主题顺序', () => {
  const next = changeHierarchy(document, 'a2', 'indent')
  assert.notEqual(next, document)
  assert.notEqual(next.root, document.root)
  assert.deepEqual(next.root.children, [
    { ...a, children: [{ ...a1, children: [...a1.children, a2] }, a3] }, b, c,
  ])
  assert.equal(next.root.children[0].children[0].children[1], a2)
  assert.equal(next.root.children[1], b)
  assert.equal(next.root.children[2], c)
})

test('升级将整棵子树插在父主题之后，保留前后分支顺序', () => {
  const next = changeHierarchy(document, 'a2', 'outdent')
  assert.deepEqual(next.root.children, [{ ...a, children: [a1, a3] }, a2, b, c])
  assert.equal(next.root.children[1], a2)
  assert.equal(next.root.children[0].children[0], a1)
  assert.equal(next.root.children[0].children[1], a3)
})

test('深层升级仅复制变更的祖先路径', () => {
  const next = changeHierarchy(document, 'b1x', 'outdent')
  assert.deepEqual(next.root.children, [
    a, { ...b, children: [{ ...b1, children: [] }, b1.children[0], b2] }, c,
  ])
  assert.equal(next.root.children[0], a)
  assert.equal(next.root.children[1].children[1], b1.children[0])
  assert.equal(next.root.children[1].children[2], b2)
})

test('上移与下移仅交换相邻完整子树，支持根分支与深层主题', () => {
  const up = changeHierarchy(document, 'a2', 'up')
  assert.deepEqual(up.root.children, [{ ...a, children: [a2, a1, a3] }, b, c])
  assert.equal(up.root.children[0].children[0], a2)
  const down = changeHierarchy(document, 'a2', 'down')
  assert.deepEqual(down.root.children, [{ ...a, children: [a1, a3, a2] }, b, c])
  assert.equal(down.root.children[0].children[2], a2)
  assert.deepEqual(changeHierarchy(document, 'b', 'up').root.children, [b, a, c])
  assert.deepEqual(changeHierarchy(document, 'b', 'down').root.children, [a, c, b])
})

test('越界、中心主题和不存在的 ID 均返回原文档对象', () => {
  const actions: HierarchyAction[] = ['indent', 'outdent', 'up', 'down']
  for (const action of actions) {
    assert.equal(changeHierarchy(document, 'root', action), document)
    assert.equal(changeHierarchy(document, 'missing', action), document)
  }
  const boundaries: [HierarchyAction, string[]][] = [
    ['indent', ['a', 'a1', 'a1x']],
    ['outdent', ['a', 'b', 'c']],
    ['up', ['a', 'a1', 'a1x']],
    ['down', ['c', 'a3', 'a1x']],
  ]
  for (const [action, ids] of boundaries) {
    for (const id of ids) assert.equal(changeHierarchy(document, id, action), document)
  }
  const empty: MindMapDocument = { type: 'mindmap', root: { id: 'only-root', text: '', children: [] } }
  for (const action of actions) assert.equal(changeHierarchy(empty, 'only-root', action), empty)
})

test('四种操作均接受 Vue reactive 文档，不修改代理源，边界仍返回代理原对象', () => {
  const source = JSON.stringify(document)
  const actions: HierarchyAction[] = ['indent', 'outdent', 'up', 'down']
  for (const action of actions) {
    const proxy = reactive(JSON.parse(source) as MindMapDocument)
    assert.ok(isReactive(proxy.root.children[0]))
    const subtree = proxy.root.children[0].children[1]
    const next = changeHierarchy(proxy, 'a2', action)
    assert.notEqual(next, proxy)
    assert.deepEqual(next, changeHierarchy(document, 'a2', action))
    assert.equal(JSON.stringify(proxy), source)
    const moved = action === 'outdent' ? next.root.children[1]
      : action === 'indent' ? next.root.children[0].children[0].children[1]
        : next.root.children[0].children[action === 'up' ? 0 : 2]
    assert.equal(moved, subtree)
    assert.equal(changeHierarchy(proxy, 'root', action), proxy)
    assert.equal(changeHierarchy(proxy, 'missing', action), proxy)
  }
})
