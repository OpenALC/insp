# Note export generation

Import the public API from `src/export/index.ts`. No dependency or platform changes
are required. These functions generate content in memory; they do not save files,
open a share sheet, copy to the clipboard, upload anything, or change the note.

```ts
import {
  exportNote, toPlainText, toMarkdown, toPng, toDocx, toPdf,
  type AttachmentResolver, type ExportFile,
} from './export'

// Wrap the existing AttachmentStore so its receiver is preserved.
const resolveAttachment: AttachmentResolver = id => platform.attachments.readImage(id)

const text: string = toPlainText(note)
const png: ExportFile = await toPng(note, resolveAttachment)
const markdown: ExportFile = await toMarkdown(note, resolveAttachment)
const word: ExportFile = await toDocx(note, resolveAttachment)
const pdf: ExportFile = await toPdf(note, resolveAttachment)

// Alternatively dispatch by format. The plaintext overload returns Promise<string>.
const result = await exportNote(note, 'docx', resolveAttachment, { includeTitle: true })

// For a browser/system adapter that accepts File:
const file = new File([result.blob], result.filename, { type: result.mimeType })
```

## Contract

- `toPlainText(note, options?)` returns a string synchronously and never resolves
  attachments. Images become `[Image: alt text]` placeholders; link destinations
  remain readable. Paragraphs and nested outlines retain line breaks and indentation.
- `toMarkdown`, `toDocx`, and `toPdf` accept `(note, resolveAttachment, options?)`
  and return `Promise<ExportFile>`.
- `toPng` accepts the same arguments with additional `width` and `scale` options.
  Defaults are 1080 logical pixels wide at 1.5 pixel density, with a white background.
- `ExportFile` is `{ filename: string, mimeType: string, blob: Blob }`. Filenames
  are derived from the title, sanitized for filesystem use, and carry the correct
  extension. No note IDs, privacy policy, group, revisions, or timestamps are added.
- Common options: `{ includeTitle?: boolean }`, defaulting to `true`. A matching
  mind map title/root appears once; the root is always content, even with
  `includeTitle: false`. Distinct legacy titles and roots are both retained.
- `AttachmentResolver` accepts an attachment ID and returns decrypted local image
  bytes as a `Blob`, synchronously or asynchronously. The current
  `AttachmentStore.readImage` is directly compatible through the wrapper above.
  PNG, JPEG, GIF, and WebP bytes are supported. Blob MIME labels are normalized from
  the file signature. Resolver errors, including vault access errors, propagate.
- Each asynchronous call snapshots title and content into detached export blocks
  before its first await. Repeated image references are resolved once per call.
  Only temporary URLs created by this layer are revoked.

## Content and output details

Rich text supports the editor's paragraphs, headings, bold, italic, underline,
strikethrough, highlight, links, inline code, code blocks, hard breaks, quotes,
ordered/bullet/task lists (including nested lists), rules, and attachment images.
Unsupported nodes or marks fail explicitly rather than silently dropping content.
Mind maps retain node order, multiline labels, and nesting as outlines in every
format. PNG/PDF add branch elbows; they do not copy the interactive editor layout.
The current mind map schema contains text nodes only, with no image field.

- Markdown is one UTF-8 `.md` file with images embedded as data URLs, requiring no
  attachment sidecars or private filesystem paths. Some Markdown viewers suppress
  data URL images or inline HTML used for underline/highlight.
- Word is a real ZIP/OOXML `.docx`, containing editable paragraphs and marks,
  heading styles, indented lists/outlines, link relationships, alt text, and embedded
  PNG images. List markers are literal text, so Word does not auto-renumber them.
  ZIP entries are stored without compression; there is no HTML renamed to `.docx`.
- PDF is paginated A4 with 192 dpi raster pages. CJK text uses the webview's local
  font fallback, and images and formatting are preserved. Text is not searchable or
  selectable, and links are not interactive. Breaks occur between lines; large
  images shrink to fit a page. Only one page canvas is retained at a time.
- PNG uses a single canvas. Exports exceeding 16,384 pixels on an axis or 32 million
  pixels total reject with `IMAGE_TOO_LARGE`; use PDF for long notes. Canvas encoding
  can also fail at a webview-specific lower limit, which is reported as an error.
- Word, PNG, and PDF flatten animated images to a still frame. Markdown retains the
  original raster bytes. None of these formats is a lossless note backup.

Plaintext and Markdown use standard browser Blob/FileReader APIs. PNG/PDF and Word
images require a browser/webview with canvas and local font support. No app DOM,
editor instance, CSS classes, print dialog, filesystem, or native bridge is needed.

## Parent integration and privacy

Invoke generation from an explicit export/share action. Pass the current in-memory
`Note`, including unsaved edits, after any pending image imports have completed.
The parent retains responsibility for access to private notes and for invoking its
save/share adapter. A generation call also works for an explicitly selected private
note, without changing its privacy/sync policy or bypassing the attachment resolver.

The module has no background work, global note cache, persistence, or share side
effects. Only referenced attachment IDs are requested. Network image URLs, `src`
attributes, and SVG are never loaded; raster signatures are checked to prevent a
mislabeled SVG from making external requests. Hyperlinks are serialized without
following them. Resolver implementations must likewise read local attachments.
Release the returned blobs/files when the export or share interaction finishes.

Catch `NoteExportError` for the typed `code` values exported from `types.ts`.
Resolver/platform errors propagate unchanged; invalid PNG dimensions throw
`RangeError`. The parent can present errors and offer another export format.
