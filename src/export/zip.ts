export interface ZipEntry { name: string; data: Uint8Array<ArrayBuffer> }

const encoder = new TextEncoder()
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** Uncompressed ZIP (method 0), sufficient for OOXML without a compression dependency. */
export function zip(entries: ZipEntry[]): Blob {
  const parts: BlobPart[] = []
  const directory: BlobPart[] = []
  let offset = 0
  let directoryLength = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30)
    const header = new DataView(local.buffer)
    header.setUint32(0, 0x04034b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 0x0800, true)
    header.setUint16(12, 0x0021, true) // 1980-01-01; no private filesystem timestamps.
    header.setUint32(14, crc, true)
    header.setUint32(18, entry.data.length, true)
    header.setUint32(22, entry.data.length, true)
    header.setUint16(26, name.length, true)
    parts.push(local, name, entry.data)

    const central = new Uint8Array(46)
    const record = new DataView(central.buffer)
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 20, true)
    record.setUint16(6, 20, true)
    record.setUint16(8, 0x0800, true)
    record.setUint16(14, 0x0021, true)
    record.setUint32(16, crc, true)
    record.setUint32(20, entry.data.length, true)
    record.setUint32(24, entry.data.length, true)
    record.setUint16(28, name.length, true)
    record.setUint32(42, offset, true)
    directory.push(central, name)
    directoryLength += central.length + name.length
    offset += local.length + name.length + entry.data.length
  }
  const end = new Uint8Array(22)
  const footer = new DataView(end.buffer)
  footer.setUint32(0, 0x06054b50, true)
  footer.setUint16(8, entries.length, true)
  footer.setUint16(10, entries.length, true)
  footer.setUint32(12, directoryLength, true)
  footer.setUint32(16, offset, true)
  return new Blob([...parts, ...directory, end], { type: 'application/zip' })
}

export function xmlEntry(name: string, value: string): ZipEntry {
  return { name, data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`) }
}
