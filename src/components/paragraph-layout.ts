import { Extension } from '@tiptap/core'

export const ParagraphLayout = Extension.create({
  name: 'paragraphLayout',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        indent: {
          default: 0,
          parseHTML: element => Number(element.getAttribute('data-indent') || 0),
          renderHTML: attributes => attributes.indent ? { 'data-indent': attributes.indent } : {},
        },
      },
    }]
  },
})
