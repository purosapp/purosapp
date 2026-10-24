/**
 * Liquid glass for web content — a backdrop SVG filter that blurs what is
 * behind an element and bends it along the element's rounded rim, the way
 * Apple's Liquid Glass lenses the content under it. Native glass views sit
 * behind the web contents and can't sample the page, so this is done in CSS.
 *
 * Relies on `backdrop-filter: url(#svg-filter)`, which only Chromium supports
 * (fine for Electron). The displacement map is generated for the element's
 * exact size and rebuilt when it resizes.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'

interface LiquidGlassOptions {
  /** The element's border radius, in px. */
  radius: number
  /** Width of the refracting rim, in px. */
  bezel?: number
  /** Largest shift at the very edge of the rim, in px. */
  refraction?: number
  /** Backdrop blur (feGaussianBlur stdDeviation), in px. */
  blur?: number
  /** Backdrop saturation multiplier. */
  saturation?: number
  /** Index of refraction of the glass; higher bends harder at the rim. */
  ior?: number
  /** Colour fringing at the rim: how much less blue bends than red (0–0.2). */
  dispersion?: number
}

interface LiquidGlass {
  style: CSSProperties
  /**
   * The filter's hidden SVG and the specular rim. Render inside the element,
   * which must be positioned (relative/absolute) for the rim to sit on it.
   */
  layers: ReactNode
}

/** Specular rim along the edge: lit from the top-left, a faint reflection bottom-right. */
const RIM_STYLE: CSSProperties = {
  background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.06) 30%, rgba(255, 255, 255, 0.03) 70%, rgba(255, 255, 255, 0.16))',
  mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
}

function roundedRectSdf(x: number, y: number, width: number, height: number, radius: number): number {
  const qx = Math.abs(x - width / 2) - (width / 2 - radius)
  const qy = Math.abs(y - height / 2) - (height / 2 - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

const PROFILE_SAMPLES = 256

/**
 * Refraction across the rim, from the edge (index 0) to the bezel's inner side.
 * The rim is a convex squircle, h(t) = (1 - (1 - t)^4)^(1/4), steep at the edge
 * and flat inside. A vertical ray hitting it refracts by Snell's law; the
 * lateral shift it picks up, tan(θ - asin(sin θ / ior)), is how far inward the
 * backdrop is sampled. Normalized so the edge shifts by 1.
 */
function buildRefractionProfile(ior: number): Float32Array {
  const surface = (t: number) => (1 - (1 - Math.min(Math.max(t, 0), 1)) ** 4) ** 0.25
  const profile = new Float32Array(PROFILE_SAMPLES)
  const step = 1 / PROFILE_SAMPLES
  let max = 0
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const t = (i + 0.5) * step
    const slope = (surface(t + step / 2) - surface(t - step / 2)) / step
    const incidence = Math.atan(slope)
    const shift = Math.tan(incidence - Math.asin(Math.sin(incidence) / ior))
    profile[i] = shift
    max = Math.max(max, shift)
  }
  for (let i = 0; i < PROFILE_SAMPLES; i++) profile[i] /= max || 1
  return profile
}

/**
 * R/G encode the x/y sampling offset around neutral 128: inside the rim the
 * backdrop is sampled inward along the edge normal by the refraction profile.
 * Offsets are unit-scaled; feDisplacementMap's `scale` sets the strength.
 */
function buildDisplacementMap(width: number, height: number, radius: number, bezel: number, ior: number): string {
  const profile = buildRefractionProfile(ior)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return ''
  const image = context.createImageData(width, height)
  const data = image.data
  const r = Math.min(radius, width / 2, height / 2)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const distance = -roundedRectSdf(px, py, width, height, r)
      let dx = 0
      let dy = 0
      if (distance > 0 && distance < bezel) {
        const nx = roundedRectSdf(px + 1, py, width, height, r) - roundedRectSdf(px - 1, py, width, height, r)
        const ny = roundedRectSdf(px, py + 1, width, height, r) - roundedRectSdf(px, py - 1, width, height, r)
        const length = Math.hypot(nx, ny) || 1
        const strength = profile[Math.min(PROFILE_SAMPLES - 1, Math.floor((distance / bezel) * PROFILE_SAMPLES))]
        dx = (-nx / length) * strength
        dy = (-ny / length) * strength
      }
      const i = (y * width + x) * 4
      data[i] = 128 + dx * 127
      data[i + 1] = 128 + dy * 127
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }

  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

export function useLiquidGlass(
  ref: RefObject<HTMLElement | null>,
  { radius, bezel = 24, refraction = 32, blur = 1.5, saturation = 1.5, ior = 1.5, dispersion = 0.08 }: LiquidGlassOptions,
): LiquidGlass {
  const filterId = `liquid-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [map, setMap] = useState('')

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize[0]
      const width = Math.round(box.inlineSize)
      const height = Math.round(box.blockSize)
      setSize((current) => (current?.width === width && current.height === height ? current : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  const hasMap = map !== ''
  const builtForRef = useRef('')
  useEffect(() => {
    if (!size || size.width === 0 || size.height === 0) return
    const key = `${size.width}x${size.height}:${radius}:${bezel}:${ior}`
    if (builtForRef.current === key) return
    const build = () => {
      builtForRef.current = key
      setMap(buildDisplacementMap(size.width, size.height, radius, bezel, ior))
    }
    // The first map is built on the next frame. After that the old map is
    // stretched over the new size until resizing settles, so an animated
    // panel (or a window drag) does not rebuild the map on every frame.
    if (!hasMap) {
      const frame = requestAnimationFrame(build)
      return () => cancelAnimationFrame(frame)
    }
    const timer = window.setTimeout(build, 150)
    return () => window.clearTimeout(timer)
  }, [size, radius, bezel, ior, hasMap])

  const backdropFilter = map && size ? `url(#${filterId})` : `blur(${blur * 1.5}px) saturate(${saturation})`

  return {
    style: { backdropFilter, WebkitBackdropFilter: backdropFilter },
    layers: (
      <>
        {map && size && (
          <svg aria-hidden width="0" height="0" className="pointer-events-none absolute">
            <filter id={filterId} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation={blur} edgeMode="duplicate" result="blurred" />
              <feImage href={map} x="0" y="0" width={size.width} height={size.height} preserveAspectRatio="none" result="map" />
              {/* One displacement per colour channel, blue bending least, so the
                  rim fringes slightly like real glass; then recombined. */}
              {(['R', 'G', 'B'] as const).map((channel, index) => (
                <feDisplacementMap
                  key={channel}
                  in="blurred"
                  in2="map"
                  scale={refraction * 2 * (1 - dispersion * index)}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result={`shifted${channel}`}
                />
              ))}
              <feColorMatrix in="shiftedR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
              <feColorMatrix in="shiftedG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
              <feColorMatrix in="shiftedB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
              <feComposite in="red" in2="green" operator="arithmetic" k2="1" k3="1" result="redGreen" />
              <feComposite in="redGreen" in2="blue" operator="arithmetic" k2="1" k3="1" result="refracted" />
              <feColorMatrix in="refracted" type="saturate" values={String(saturation)} />
            </filter>
          </svg>
        )}
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] p-px" style={RIM_STYLE} />
      </>
    ),
  }
}
