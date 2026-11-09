import type { MindMapDocument, MindMapNode } from './mindmap'

export type HierarchyAction = 'indent' | 'outdent' | 'up' | 'down'

function findPath(node: MindMapNode, id: string): MindMapNode[] | undefined {
  if (node.id === id) return [node]
  for (const child of node.children) {
    const path = findPath(child, id)
    if (path) return [node, ...path]
  }
}

function replaceBranch(path: MindMapNode[], replacement: MindMapNode): MindMapNode {
  let next = replacement
  for (let index = path.length - 2; index >= 0; index--) {
    const ancestor = path[index]
    const childId = path[index + 1].id
    next = {
      ...ancestor,
      children: ancestor.children.map(child => child.id === childId ? next : child),
    }
  }
  return next
}

export function changeHierarchy(document: MindMapDocument, id: string, action: HierarchyAction): MindMapDocument {
  const path = findPath(document.root, id)
  if (!path || path.length < 2) return document

  const node = path[path.length - 1]
  const parent = path[path.length - 2]
  const index = parent.children.findIndex(child => child.id === id)
  const children = [...parent.children]

  if (action === 'outdent') {
    if (path.length < 3) return document
    const grandparent = path[path.length - 3]
    const parentIndex = grandparent.children.findIndex(child => child.id === parent.id)
    children.splice(index, 1)
    const branches = [...grandparent.children]
    branches.splice(parentIndex, 1, { ...parent, children }, node)
    return {
      ...document,
      root: replaceBranch(path.slice(0, -2), { ...grandparent, children: branches }),
    }
  }

  if (action === 'indent') {
    if (index === 0) return document
    const previous = children[index - 1]
    children[index - 1] = { ...previous, children: [...previous.children, node] }
    children.splice(index, 1)
  } else {
    const destination = index + (action === 'up' ? -1 : 1)
    if (destination < 0 || destination >= children.length) return document
    ;[children[index], children[destination]] = [children[destination], children[index]]
  }

  return {
    ...document,
    root: replaceBranch(path.slice(0, -1), { ...parent, children }),
  }
}
