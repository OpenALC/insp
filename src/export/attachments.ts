import { NoteExportError, type AttachmentResolver } from './types'

async function rasterBlob(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  let type: string
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) type = 'image/png'
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'image/jpeg'
  else if (new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/)) type = 'image/gif'
  else if (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
    && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') type = 'image/webp'
  else throw new NoteExportError('UNSUPPORTED_IMAGE', 'Only PNG, JPEG, GIF and WebP attachment bytes are supported.')
  // Check bytes, not just MIME: a mislabeled SVG must never load remote resources.
  return new Blob([blob], { type })
}

/** Each export owns its cache; private attachment bytes never enter a global cache. */
export function attachmentLoader(resolve: AttachmentResolver): (id: string) => Promise<Blob> {
  const cache = new Map<string, Promise<Blob>>()
  return id => {
    let pending = cache.get(id)
    if (!pending) {
      pending = Promise.resolve(resolve(id)).then(rasterBlob)
      cache.set(id, pending)
    }
    return pending
  }
}

export function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function withImage<T>(blob: Blob, use: (image: HTMLImageElement) => T | Promise<T>): Promise<T> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new NoteExportError('IMAGE_DECODE_FAILED', 'An attachment could not be decoded.'))
    })
    image.src = url
    await loaded
    return await use(image)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function canvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  const ctx = element.getContext('2d')
  if (!ctx) throw new NoteExportError('CANVAS_UNAVAILABLE', 'This webview does not support canvas export.')
  return { canvas: element, ctx }
}

export function canvasBlob(element: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    element.toBlob(blob => blob ? resolve(blob) : reject(new NoteExportError(
      'IMAGE_TOO_LARGE', 'The webview could not encode this canvas. Export as PDF for a long note.',
    )), type, type === 'image/jpeg' ? 0.94 : undefined)
  })
}

export async function pngImage(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  return withImage(blob, async image => {
    const { canvas: element, ctx } = canvas(image.naturalWidth, image.naturalHeight)
    try {
      ctx.drawImage(image, 0, 0)
      return { blob: await canvasBlob(element), width: element.width, height: element.height }
    } finally {
      element.width = element.height = 0
    }
  })
}
