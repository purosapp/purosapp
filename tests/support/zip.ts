import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export interface TestZipEntry {
  path: string
  data: Buffer
  mode: number
  method: number
  flags: number
  dosTime: number
  dosDate: number
  madeBy: number
}

/**
 * Minimal test-only reader, deliberately independent of the packer's writer.
 * It checks the central directory against every local header and CRC.
 */
export function readTestZip(archive: Buffer): TestZipEntry[] {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endOffset < 0 || endOffset + 22 > archive.length) throw new Error('Missing ZIP end-of-central-directory record')
  const count = archive.readUInt16LE(endOffset + 10)
  const directorySize = archive.readUInt32LE(endOffset + 12)
  let cursor = archive.readUInt32LE(endOffset + 16)
  if (cursor + directorySize !== endOffset) throw new Error('ZIP central directory does not end at the end record')
  const entries: TestZipEntry[] = []
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Bad central directory signature')
    const madeBy = archive.readUInt16LE(cursor + 4)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const dosTime = archive.readUInt16LE(cursor + 12)
    const dosDate = archive.readUInt16LE(cursor + 14)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const external = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Bad local header for ${name}`)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    if (archive.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength) !== name) throw new Error(`Local name mismatch for ${name}`)
    if (archive.readUInt32LE(localOffset + 14) !== crc || archive.readUInt32LE(localOffset + 18) !== compressedSize) {
      throw new Error(`Local header disagrees with central directory for ${name}`)
    }
    const start = localOffset + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(start, start + compressedSize)
    const data = method === 8 ? zlib.inflateRawSync(payload) : method === 0 ? Buffer.from(payload) : null
    if (!data) throw new Error(`Unsupported compression method ${method} for ${name}`)
    if (data.length !== size || (zlib.crc32(data) >>> 0) !== crc) throw new Error(`Size or CRC mismatch for ${name}`)
    entries.push({ path: name, data, mode: (external >>> 16) & 0o7777, method, flags, dosTime, dosDate, madeBy })
  }
  return entries
}

/** Extracts a trusted test archive; production import validation is a separate stage. */
export function extractTestZip(archivePath: string, destination: string): TestZipEntry[] {
  const entries = readTestZip(fs.readFileSync(archivePath))
  for (const entry of entries) {
    const target = path.resolve(destination, entry.path)
    if (!target.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new Error(`Test archive path escapes: ${entry.path}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data, { mode: entry.mode })
  }
  return entries
}
