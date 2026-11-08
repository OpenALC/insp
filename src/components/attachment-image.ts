import { Node } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import AttachmentImageNode from './AttachmentImageNode.vue'

export const AttachmentImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null },
      alt: { default: '' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'img[data-note-image][data-attachment-id]',
        getAttrs: (element) => {
          const image = element as HTMLImageElement
          return {
            attachmentId: image.getAttribute('data-attachment-id'),
            alt: image.getAttribute('alt') ?? '',
          }
        },
      },
    ]
  },

  renderHTML({ node }) {
    return [
      'img',
      {
        'data-note-image': 'true',
        'data-attachment-id': node.attrs.attachmentId,
        alt: node.attrs.alt ?? '',
      },
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(AttachmentImageNode)
  },
})
