export interface MindMapNode {
  id: string
  text: string
  children: MindMapNode[]
}

export interface MindMapDocument {
  type: 'mindmap'
  root: MindMapNode
}

export const UNTITLED_MIND_MAP = '未命名的思维笔记'

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

export function createMindMapDocument(title = UNTITLED_MIND_MAP): MindMapDocument {
  return { type: 'mindmap', root: { id: crypto.randomUUID(), text: title, children: [] } }
}

// Older clients stored a separate title and root. Keep both when both were authored.
export function unifyMindMapTitle(title: string, doc: MindMapDocument): MindMapDocument {
  const root = doc.root
  if (title === root.text && title.trim()) return doc
  const named = title.trim() && !['未命名笔记', '未命名导图', '未命名思维导图', '未命名思维笔记', UNTITLED_MIND_MAP].includes(title)
  const topic = root.text.trim() && root.text !== '中心主题'
  if (named && topic) return { ...doc, root: { id: 'title:' + root.id, text: title, children: [root] } }
  return { ...doc, root: { ...root, text: named ? title : topic ? root.text : UNTITLED_MIND_MAP } }
}

export function mindMapText(document: MindMapDocument): string {
  const visit = (node: MindMapNode): string[] => [node.text, ...node.children.flatMap(visit)]
  return visit(document.root).join('\n')
}
