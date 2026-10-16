export function artworkUrl(artworkId?: string | null, filePath?: string | null): string | undefined {
  if (artworkId) return `artwork://cache/${encodeURIComponent(artworkId)}`
  if (filePath && /^(https?:|artwork:|data:)/i.test(filePath)) return filePath
  if (filePath) return `artwork://file?path=${encodeURIComponent(filePath)}`
  return undefined
}
