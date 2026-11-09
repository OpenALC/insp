export interface MindMapNode {
  id: string
  text: string
  children: MindMapNode[]
}

export interface MindMapDocument {
  type: 'mindmap'
  root: MindMapNode
}

export interface MindMapPreview {
  root: string
  branches: string[]
  remaining: number
}

export function mindMapPreview(document: MindMapDocument): MindMapPreview {
  return {
    root: document.root.text.slice(0, 80),
    branches: document.root.children.slice(0, 3).map(child => child.text.slice(0, 60)),
    remaining: Math.max(0, document.root.children.length - 3),
  }
}

export function createMindMapDocument(): MindMapDocument {
  return { type: 'mindmap', root: { id: crypto.randomUUID(), text: '中心主题', children: [] } }
}

export function mindMapText(document: MindMapDocument): string {
  const visit = (node: MindMapNode): string[] => [node.text, ...node.children.flatMap(visit)]
  return visit(document.root).join('\n')
}
