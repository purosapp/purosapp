const CPU_NAMES: Record<number, string> = { 0x01000007: 'x86_64', 0x0100000c: 'arm64' }
const DYLIB_COMMANDS = new Set([0xc, 0x80000018, 0x8000001f, 0x80000023])

function cpuName(cpuType: number): string {
  return CPU_NAMES[cpuType >>> 0] ?? `cpu-${(cpuType >>> 0).toString(16)}`
}

interface Slice { offset: number; arch: string }

function slices(buffer: Buffer): Slice[] | null {
  if (buffer.length < 8) return null
  const magic = buffer.readUInt32BE(0)
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = buffer.readUInt32BE(4)
    const stride = magic === 0xcafebabf ? 32 : 20
    if (count < 1 || count > 16 || buffer.length < 8 + count * stride) return null
    const result: Slice[] = []
    for (let index = 0; index < count; index += 1) {
      const base = 8 + index * stride
      const offset = magic === 0xcafebabf ? Number(buffer.readBigUInt64BE(base + 8)) : buffer.readUInt32BE(base + 8)
      result.push({ offset, arch: cpuName(buffer.readUInt32BE(base)) })
    }
    return result
  }
  const thin = buffer.readUInt32LE(0)
  if (thin === 0xfeedfacf || thin === 0xfeedface) return [{ offset: 0, arch: cpuName(buffer.readUInt32LE(4)) }]
  return null
}

/** CPU architectures of a thin or universal Mach-O, or null for anything else (for example a script). */
export function machOArchitectures(buffer: Buffer): string[] | null {
  const found = slices(buffer)
  return found ? [...new Set(found.map((slice) => slice.arch))].sort() : null
}

/** Dylib load paths from every 64-bit slice. */
export function machODylibs(buffer: Buffer): string[] {
  const libraries = new Set<string>()
  for (const { offset } of slices(buffer) ?? []) {
    if (buffer.length < offset + 32 || buffer.readUInt32LE(offset) !== 0xfeedfacf) continue
    const commands = buffer.readUInt32LE(offset + 16)
    let cursor = offset + 32
    for (let index = 0; index < commands && cursor + 8 <= buffer.length; index += 1) {
      const command = buffer.readUInt32LE(cursor)
      const size = buffer.readUInt32LE(cursor + 4)
      if (size < 8) break
      if (DYLIB_COMMANDS.has(command) && cursor + 12 <= buffer.length) {
        const start = cursor + buffer.readUInt32LE(cursor + 8)
        const end = buffer.indexOf(0, start)
        if (end > start && end <= cursor + size) libraries.add(buffer.toString('utf8', start, end))
      }
      cursor += size
    }
  }
  return [...libraries]
}

/** Absolute dylib paths outside macOS itself; a clean Mac will not have them. */
export function nonSystemDylibs(buffer: Buffer): string[] {
  return machODylibs(buffer).filter((library) => library.startsWith('/')
    && !library.startsWith('/usr/lib/') && !library.startsWith('/System/'))
}
