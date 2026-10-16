import type { Track } from '../store/playerStore'
import type { ProviderDescriptorV1, ProviderResultV1, ProviderValueV1 } from '../provider-api/v1'

export type RgbColor = { r: number; g: number; b: number }

export const DEFAULT_ARTWORK_AMBIENT_COLOR: RgbColor = { r: 44, g: 44, b: 52 }

export function resolveArtwork(track: Track | null): string | null {
  if (!track) return null
  return track.coverUrl ?? track.artworkUrl ?? null
}

function maximizeRemoteArtworkUrl(value: string): string {
  if (!/^https?:/i.test(value)) return value

  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()

    if (hostname.endsWith('mzstatic.com')) {
      url.pathname = url.pathname.replace(
        /\/\d+x\d+([a-z0-9]*)\.(jpe?g|png|webp)$/i,
        '/3000x3000$1.$2',
      )
      return url.toString()
    }

    if (hostname === 'coverartarchive.org') {
      url.pathname = url.pathname.replace(/-(250|500|1200)(\.(?:jpe?g|png))$/i, '$2')
      return url.toString()
    }
  } catch {
    return value
  }

  return value
}

type InvokeArtworkProvider = (
  providerId: string,
  capability: 'metadata.artwork',
  method: string,
  args: ProviderValueV1[],
) => Promise<ProviderResultV1<ProviderValueV1 | undefined>>

export async function resolveHighResolutionArtwork(
  track: Track | null,
  providers: readonly ProviderDescriptorV1[],
  invokeProvider: InvokeArtworkProvider,
): Promise<string | null> {
  if (!track) return null
  const providerArtwork = track.discordArtworkUrl
  const fallback = providerArtwork ? maximizeRemoteArtworkUrl(providerArtwork) : resolveArtwork(track)
  const providerId = track.provider ?? track.sourceType
  if (!providerArtwork || !providerId) return fallback
  const descriptor = providers.find(({ manifest }) => manifest.id === providerId)
  if (!descriptor?.manifest.capabilities.includes('metadata.artwork')) return fallback
  if (descriptor.status.state !== 'ready' && descriptor.status.state !== 'degraded') return fallback

  try {
    const result = await invokeProvider(providerId, 'metadata.artwork', 'getDisplayArtworkUrl', [providerArtwork])
    if (!result.ok || typeof result.value !== 'string') return fallback
    const url = new URL(result.value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : fallback
  } catch {
    return fallback
  }
}

export function rgba(color: RgbColor, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`
}

export async function sampleArtworkColor(src: string | null): Promise<RgbColor> {
  if (!src) return DEFAULT_ARTWORK_AMBIENT_COLOR

  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 28
        canvas.height = 28
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(DEFAULT_ARTWORK_AMBIENT_COLOR)
          return
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)

        let totalWeight = 0
        let red = 0
        let green = 0
        let blue = 0

        for (let index = 0; index < data.length; index += 4) {
          const r = data[index]
          const g = data[index + 1]
          const b = data[index + 2]
          const alpha = data[index + 3] / 255
          const brightness = (r + g + b) / 3
          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          const saturation = max === 0 ? 0 : (max - min) / max
          const weight = alpha * (0.35 + saturation) * (brightness > 18 ? 1 : 0.15)

          red += r * weight
          green += g * weight
          blue += b * weight
          totalWeight += weight
        }

        if (totalWeight <= 0) {
          resolve(DEFAULT_ARTWORK_AMBIENT_COLOR)
          return
        }

        resolve({
          r: Math.round(red / totalWeight),
          g: Math.round(green / totalWeight),
          b: Math.round(blue / totalWeight),
        })
      } catch {
        resolve(DEFAULT_ARTWORK_AMBIENT_COLOR)
      }
    }
    image.onerror = () => resolve(DEFAULT_ARTWORK_AMBIENT_COLOR)
    image.src = src
  })
}
