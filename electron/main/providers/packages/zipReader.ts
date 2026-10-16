import zlib from 'node:zlib'
import {
  MAX_ARCHIVE_BYTES,
  MODE_EXECUTABLE,
  MODE_FILE,
  PACKAGE_LIMITS,
  packageError,
  validatePackagePath,
} from './format'

export interface PackageArchiveEntry {
  path: string
  mode: number
  data: Buffer
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_RECORD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const UTF8_FLAG = 0x0800
const UNIX_HOST = 3
const REGULAR_FILE = 0o100000
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Strict reader for the provider package subset of ZIP. It accepts exactly what
 * the Puros packer writes and rejects everything else: comments, extra fields,
 * ZIP64, encryption, data descriptors, directories, symlinks, gaps/overlaps,
 * unusual modes, duplicate or case-colliding names, and size/CRC mismatches.
 */
export function readPackageArchive(archive: Buffer): PackageArchiveEntry[] {
  if (archive.length > MAX_ARCHIVE_BYTES) packageError('Package archive is too large')
  if (archive.length < 22) packageError('Package is not a ZIP archive')
  // No archive comment is allowed, so the end record sits exactly at the end.
  const endOffset = archive.length - 22
  if (archive.readUInt32LE(endOffset) !== END_RECORD) packageError('Package ZIP end record is missing or followed by a comment')
  if (endOffset >= 20 && archive.readUInt32LE(endOffset - 20) === ZIP64_LOCATOR) packageError('ZIP64 packages are not supported')
  const diskNumber = archive.readUInt16LE(endOffset + 4)
  const directoryDisk = archive.readUInt16LE(endOffset + 6)
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8)
  const entryCount = archive.readUInt16LE(endOffset + 10)
  const directorySize = archive.readUInt32LE(endOffset + 12)
  const directoryOffset = archive.readUInt32LE(endOffset + 16)
  if (archive.readUInt16LE(endOffset + 20) !== 0) packageError('Package ZIP comments are not allowed')
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) packageError('Multi-disk ZIP packages are not supported')
  if (entryCount === 0 || entryCount > PACKAGE_LIMITS.maxEntries) packageError('Package has no entries or too many entries')
  if (directoryOffset + directorySize !== endOffset) packageError('Package central directory is not contiguous with the end record')

  const entries: PackageArchiveEntry[] = []
  const names = new Set<string>()
  const foldedNames = new Set<string>()
  let cursor = directoryOffset
  let expectedLocalOffset = 0
  let totalBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== CENTRAL_HEADER) packageError('Package central directory is malformed')
    const madeBy = archive.readUInt16LE(cursor + 4)
    const versionNeeded = archive.readUInt16LE(cursor + 6)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const startDisk = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength > endOffset) packageError('Package central directory is truncated')
    let name: string
    try {
      name = utf8.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength))
    } catch {
      packageError('Package entry name is not valid UTF-8')
    }
    cursor += 46 + nameLength + extraLength + commentLength

    const label = JSON.stringify(name)
    if (flags !== UTF8_FLAG) packageError(`Entry ${label} uses unsupported ZIP flags (encryption, data descriptor, or non-UTF-8 name)`)
    if (versionNeeded > 20 || (madeBy >> 8) !== UNIX_HOST) packageError(`Entry ${label} was not written by a supported packer`)
    if (extraLength !== 0 || commentLength !== 0 || startDisk !== 0) packageError(`Entry ${label} has extra fields, a comment, or a disk split`)
    if (method !== 0 && method !== 8) packageError(`Entry ${label} uses unsupported compression method ${method}`)
    const pathProblem = validatePackagePath(name)
    if (pathProblem) packageError(`Entry ${label} has an unsafe path: ${pathProblem}`)
    if (names.has(name)) packageError(`Entry ${label} is duplicated`)
    const folded = name.toLowerCase()
    if (foldedNames.has(folded)) packageError(`Entry ${label} collides case-insensitively with another entry`)
    names.add(name)
    foldedNames.add(folded)
    const fileType = (externalAttributes >>> 16) & 0o170000
    const mode = (externalAttributes >>> 16) & 0o7777
    if (fileType !== REGULAR_FILE || (mode !== MODE_FILE && mode !== MODE_EXECUTABLE)) {
      packageError(`Entry ${label} must be a regular file with mode 0644 or 0755`)
    }
    if (size > PACKAGE_LIMITS.maxFileBytes) packageError(`Entry ${label} exceeds the per-file size limit`)
    totalBytes += size
    if (totalBytes > PACKAGE_LIMITS.maxTotalBytes) packageError('Package exceeds the total uncompressed size limit')
    if (method === 0 && compressedSize !== size) packageError(`Stored entry ${label} has inconsistent sizes`)

    // Entries must be laid out back to back in directory order: no gaps, overlaps, or hidden data.
    if (localOffset !== expectedLocalOffset) packageError(`Entry ${label} is not contiguous with the previous entry`)
    if (localOffset + 30 > directoryOffset || archive.readUInt32LE(localOffset) !== LOCAL_HEADER) packageError(`Entry ${label} local header is missing`)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    if (archive.readUInt16LE(localOffset + 4) !== versionNeeded
      || archive.readUInt16LE(localOffset + 6) !== flags
      || archive.readUInt16LE(localOffset + 8) !== method
      || archive.readUInt32LE(localOffset + 14) !== crc
      || archive.readUInt32LE(localOffset + 18) !== compressedSize
      || archive.readUInt32LE(localOffset + 22) !== size
      || localNameLength !== nameLength
      || localExtraLength !== 0
      || !archive.subarray(localOffset + 30, localOffset + 30 + nameLength).equals(Buffer.from(name, 'utf8'))) {
      packageError(`Entry ${label} local header disagrees with the central directory`)
    }
    const dataStart = localOffset + 30 + nameLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > directoryOffset) packageError(`Entry ${label} data overruns the central directory`)
    expectedLocalOffset = dataEnd

    const payload = archive.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === 0) {
      data = Buffer.from(payload)
    } else {
      try {
        // Inflating never produces more than the declared size, which bounds compression bombs.
        data = zlib.inflateRawSync(payload, { maxOutputLength: Math.max(size, 1) })
      } catch {
        packageError(`Entry ${label} has corrupt or oversized compressed data`)
      }
    }
    if (data.length !== size || (zlib.crc32(data) >>> 0) !== crc) packageError(`Entry ${label} fails its size or CRC-32 check`)
    entries.push({ path: name, mode, data })
  }
  if (cursor !== endOffset) packageError('Package central directory has trailing data')
  if (expectedLocalOffset !== directoryOffset) packageError('Package has data between its entries and central directory')
  return entries
}
