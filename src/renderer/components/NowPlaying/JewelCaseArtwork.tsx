// The cover as the front insert of a CD jewel case: a clear, smoky plastic box
// in CSS 3D that turns gently towards the pointer.

import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'

interface JewelCaseArtworkProps {
  src: string | null
  /** Follow the pointer. Off while the overlay is closed or the window is in the background. */
  active: boolean
  dimmed: boolean
}

// A real case is 142 × 125 × 10 mm with a 120 mm booklet beside the hinge;
// sizes are in cqw of the case width.
const CASE_HEIGHT = 88
const CASE_DEPTH = 7
const HINGE_WIDTH = 11
const ART_SIZE = 84.5
const ART_LEFT = 12.5
const ART_TOP = (CASE_HEIGHT - ART_SIZE) / 2
const RADIUS = '0.9cqw'

const MAX_TURN_DEG = 15
const MAX_TILT_DEG = 9
// Pointer outside the window: turned slightly so the case still reads as 3D.
const REST = { x: -0.35, y: -0.2 }
// Time constant of the easing towards the pointer, in ms.
const EASE_MS = 140

const cq = (value: number) => `${value}cqw`

const face: CSSProperties = { position: 'absolute', borderRadius: RADIUS }

const PLASTIC_EDGE: CSSProperties = {
  ...face,
  background: 'linear-gradient(180deg, rgba(235,240,250,0.22), rgba(200,205,220,0.10) 50%, rgba(235,240,250,0.18))',
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.16)',
  borderRadius: '0.4cqw',
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, value))
}

export default function JewelCaseArtwork({ src, active, dimmed }: JewelCaseArtworkProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const caseRef = useRef<HTMLDivElement>(null)
  // Kept across pauses, so the case picks up where it was.
  const poseRef = useRef({ ...REST })

  useEffect(() => {
    const root = rootRef.current
    const caseElement = caseRef.current
    if (!root || !caseElement) return

    const current = poseRef.current
    let target = { ...current }
    let frame = 0
    let lastTime = 0

    // Written straight to the DOM: no React render per pointer move.
    const apply = () => {
      caseElement.style.transform = `rotateX(${(-current.y * MAX_TILT_DEG).toFixed(3)}deg) rotateY(${(current.x * MAX_TURN_DEG).toFixed(3)}deg)`
      root.style.setProperty('--jc-x', current.x.toFixed(4))
      root.style.setProperty('--jc-y', current.y.toFixed(4))
    }
    apply()

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!active || reducedMotion) return

    const step = (time: number) => {
      const elapsed = lastTime ? Math.min(time - lastTime, 64) : 16
      lastTime = time
      const amount = 1 - Math.exp(-elapsed / EASE_MS)
      current.x += (target.x - current.x) * amount
      current.y += (target.y - current.y) * amount
      apply()
      if (Math.abs(target.x - current.x) > 0.0005 || Math.abs(target.y - current.y) > 0.0005) {
        frame = requestAnimationFrame(step)
      } else {
        frame = 0
        lastTime = 0
      }
    }
    const aim = (next: { x: number; y: number }) => {
      target = next
      if (!frame) frame = requestAnimationFrame(step)
    }

    // Measured from the untransformed root, against half the window, so the
    // whole window steers it and the case faces the pointer.
    const handlePointerMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect()
      aim({
        x: clamp((event.clientX - (rect.left + rect.width / 2)) / (window.innerWidth / 2)),
        y: clamp((event.clientY - (rect.top + rect.height / 2)) / (window.innerHeight / 2)),
      })
    }
    const handleMouseOut = (event: MouseEvent) => {
      if (!event.relatedTarget) aim(REST)
    }
    const handleBlur = () => aim(REST)

    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    window.addEventListener('mouseout', handleMouseOut)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('mouseout', handleMouseOut)
      window.removeEventListener('blur', handleBlur)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [active])

  const halfDepth = CASE_DEPTH / 2

  return (
    <div ref={rootRef} className="relative flex aspect-square w-full items-center justify-center">
      <div className="relative w-[94%]" style={{ containerType: 'inline-size' }}>
        {/* Contact shadow, drifting against the turn. */}
        <div
          className="pointer-events-none absolute left-0 w-full"
          style={{
            top: '50%',
            height: cq(CASE_HEIGHT),
            marginTop: cq(-CASE_HEIGHT / 2),
            borderRadius: RADIUS,
            background: 'rgba(0,0,0,0.28)',
            boxShadow: '0 3cqw 9cqw rgba(0,0,0,0.55)',
            transform: 'translate3d(calc(var(--jc-x, 0) * -3cqw), calc(2.5cqw + var(--jc-y, 0) * -2cqw), 0) scale(0.97)',
          }}
        />

        <div className="relative w-full" style={{ height: cq(CASE_HEIGHT), perspective: '260cqw' }}>
          <div ref={caseRef} className="absolute inset-0" style={{ transformStyle: 'preserve-3d', willChange: 'transform' }}>
            {/* Tray: dark, smoky plastic seen around the booklet. */}
            <div
              style={{
                ...face,
                inset: 0,
                transform: `translateZ(${cq(-halfDepth)})`,
                background: 'linear-gradient(160deg, rgba(28,30,36,0.62), rgba(8,9,12,0.72))',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
              }}
            />
            {/* Spine block of the tray behind the hinge. */}
            <div
              style={{
                ...face,
                left: 0,
                top: 0,
                width: cq(HINGE_WIDTH),
                height: '100%',
                transform: `translateZ(${cq(-halfDepth / 3)})`,
                background: 'linear-gradient(90deg, rgba(20,22,28,0.55), rgba(40,43,52,0.35))',
              }}
            />

            {/* The cover, held just under the lid. */}
            <div
              style={{
                ...face,
                left: cq(ART_LEFT),
                top: cq(ART_TOP),
                width: cq(ART_SIZE),
                height: cq(ART_SIZE),
                borderRadius: '0.25cqw',
                overflow: 'hidden',
                transform: `translateZ(${cq(halfDepth - 0.5)})`,
                boxShadow: '0 0 0.6cqw rgba(0,0,0,0.45)',
                background: '#18181b',
              }}
            >
              {src ? <img src={src} alt="" className="h-full w-full object-cover" draggable={false} /> : null}
              {dimmed ? (
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_36%,rgba(0,0,0,0.08)_62%,rgba(0,0,0,0.3)_100%)]" />
              ) : null}
            </div>

            {/* Clear lid with the ribbed hinge, the booklet tabs and a moving glare. */}
            <div
              style={{
                ...face,
                inset: 0,
                overflow: 'hidden',
                transform: `translateZ(${cq(halfDepth)})`,
                background: 'linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02) 42%, rgba(255,255,255,0.05))',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.20), inset 0 0.2cqw 0.4cqw rgba(255,255,255,0.10)',
              }}
            >
              <div
                className="absolute inset-y-0 left-0"
                style={{
                  width: cq(HINGE_WIDTH),
                  background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.10) 0 0.22cqw, rgba(255,255,255,0.025) 0.22cqw 0.75cqw)',
                  boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.22), 0.3cqw 0 0.6cqw rgba(0,0,0,0.18)',
                }}
              />
              {[0, 1].map((index) => (
                <div
                  key={index}
                  className="absolute left-0"
                  style={{
                    top: index === 0 ? 0 : undefined,
                    bottom: index === 1 ? 0 : undefined,
                    width: cq(HINGE_WIDTH),
                    height: cq(7),
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.05))',
                    boxShadow: index === 0 ? 'inset 0 -1px 0 rgba(255,255,255,0.18)' : 'inset 0 1px 0 rgba(255,255,255,0.18)',
                  }}
                />
              ))}
              {[0.28, 0.72].map((at) => (
                <div
                  key={at}
                  className="absolute"
                  style={{
                    right: cq(0.8),
                    top: cq(CASE_HEIGHT * at - 3),
                    width: cq(1.4),
                    height: cq(6),
                    borderRadius: '0.4cqw',
                    background: 'rgba(255,255,255,0.10)',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)',
                  }}
                />
              ))}
              <div
                className="pointer-events-none absolute"
                style={{
                  inset: '-60%',
                  background: 'linear-gradient(115deg, transparent 38%, rgba(255,255,255,0.16) 46%, rgba(255,255,255,0.05) 50%, transparent 58%)',
                  transform: 'translate3d(calc(var(--jc-x, 0) * -22%), calc(var(--jc-y, 0) * -14%), 0)',
                }}
              />
            </div>

            {/* Edges, so the depth shows as it turns. The left one is the hinge spine. */}
            <div
              style={{
                ...PLASTIC_EDGE,
                left: 0,
                top: '50%',
                width: '100%',
                height: cq(CASE_DEPTH),
                marginTop: cq(-halfDepth),
                transform: `rotateX(90deg) translateZ(${cq(CASE_HEIGHT / 2)})`,
              }}
            />
            <div
              style={{
                ...PLASTIC_EDGE,
                left: 0,
                top: '50%',
                width: '100%',
                height: cq(CASE_DEPTH),
                marginTop: cq(-halfDepth),
                transform: `rotateX(-90deg) translateZ(${cq(CASE_HEIGHT / 2)})`,
              }}
            />
            <div
              style={{
                ...PLASTIC_EDGE,
                top: 0,
                left: '50%',
                width: cq(CASE_DEPTH),
                height: '100%',
                marginLeft: cq(-halfDepth),
                transform: `rotateY(90deg) translateZ(${cq(50)})`,
              }}
            />
            <div
              style={{
                ...PLASTIC_EDGE,
                top: 0,
                left: '50%',
                width: cq(CASE_DEPTH),
                height: '100%',
                marginLeft: cq(-halfDepth),
                transform: `rotateY(-90deg) translateZ(${cq(50)})`,
                background: 'repeating-linear-gradient(180deg, rgba(235,240,250,0.24) 0 0.5cqw, rgba(170,175,190,0.12) 0.5cqw 1.1cqw)',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
