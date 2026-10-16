export interface AudioPlugin {
  path: string
  name: string
  enabled: boolean
  parameters?: Record<string, number>
}

export interface AudioPluginParameter {
  id: number
  name: string
  value: number
  display: string
}

export interface InstalledAudioPlugin {
  path: string
  name: string
  format: 'VST' | 'VST3'
}
