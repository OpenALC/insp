export interface MindMapNode {
  id: string
  text: string
  children: MindMapNode[]
}

export interface MindMapDocument {
  type: 'mindmap'
  root: MindMapNode
}

export function createMindMapDocument(): MindMapDocument {
  return { type: 'mindmap', root: { id: crypto.randomUUID(), text: '中心主题', children: [] } }
}

export function mindMapText(document: MindMapDocument): string {
  const visit = (node: MindMapNode): string[] => [node.text, ...node.children.flatMap(visit)]
  return visit(document.root).join('\n')
}
