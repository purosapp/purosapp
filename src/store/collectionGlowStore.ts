import { create } from 'zustand'
import type { RgbColor } from '../utils/artworkColor'

/**
 * The open collection's key colour and backdrop photo. CollectionView writes
 * them; the shell paints the glow and the photo behind the title bar and the
 * page so they reach the top of the window instead of starting under the bar.
 */
interface CollectionGlowState {
  color: RgbColor | null
  /** Artist photo spread behind the hero, or null for the plain glow. */
  backdrop: string | null
  setColor: (color: RgbColor | null) => void
  setBackdrop: (backdrop: string | null) => void
}

export const useCollectionGlowStore = create<CollectionGlowState>((set) => ({
  color: null,
  backdrop: null,
  setColor: (color) => set({ color }),
  setBackdrop: (backdrop) => set({ backdrop }),
}))
