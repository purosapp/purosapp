export interface VisualizerPlaybackState {
  track: { id: string; title: string; artist: string } | null
  isPlaying: boolean
}

let state: VisualizerPlaybackState = { track: null, isPlaying: false }

export function getVisualizerPlaybackState(): VisualizerPlaybackState { return state }

export function setVisualizerTrack(track: { title: string; artist: string; album: string; catalogTrackId?: string | null; sourceId?: string | null }): void {
  state = { ...state, track: {
    id: track.catalogTrackId || track.sourceId || JSON.stringify([track.artist, track.album, track.title]),
    title: track.title, artist: track.artist,
  } }
}

export function setVisualizerPlaying(playing: boolean): void { state = { ...state, isPlaying: playing } }
export function clearVisualizerTrack(): void { state = { track: null, isPlaying: false } }
