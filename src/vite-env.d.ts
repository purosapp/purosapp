/// <reference types="vite/client" />

// File System Access API — missing from default TS lib
interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>
}

// Butterchurn — no official types
declare module 'butterchurn' {
  export interface BcVisualizerOptions {
    width: number
    height: number
    pixelRatio?: number
    meshWidth?: number
    meshHeight?: number
  }
  export interface BcVisualizer {
    connectAudio(node: AudioNode): void
    disconnectAudio(node: AudioNode): void
    loadPreset(preset: unknown, blendTime?: number): void
    setRendererSize(width: number, height: number): void
    render(opts?: object): void
    launchSongTitleAnim(text: string): void
  }
  export interface BcStatic {
    createVisualizer(
      context: AudioContext,
      canvas: HTMLCanvasElement,
      opts: BcVisualizerOptions,
    ): BcVisualizer
  }
  // The CJS bundle may expose the class directly or nested under .default
  const butterchurn: BcStatic & { default?: BcStatic }
  export default butterchurn
}

declare module 'butterchurn-presets' {
  export interface BcPresetsStatic {
    getPresets(): Record<string, unknown>
  }
  // Same CJS interop caveat as butterchurn
  const presets: BcPresetsStatic & { default?: BcPresetsStatic }
  export default presets
}

declare module 'milkdrop-preset-utils' {
  export interface SplitPreset {
    presetVersion: string
    baseVals: Record<string, number>
    presetInit: string
    perFrame: string
    perVertex: string
    pixels: string
    warp: string
    comp: string
    shapes: unknown[]
    waves: unknown[]
  }
  export function splitPreset(text: string): SplitPreset
  export function prepareShader(shader: string): string
  export function processUnOptimizedShader(shader: string): string
}

declare module 'hlslparser-js' {
  export function convertHLSLShader(source: string, entry: string, stage: 'fs'): Promise<string>
}
