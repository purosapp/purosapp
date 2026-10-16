/**
 * Parser for AutoEQ parametric EQ text files.
 *
 * Format:
 *   Preamp: -6.5 dB
 *   Filter 1: ON PK Fc 105 Hz Gain -3.5 dB Q 0.70
 *   Filter 2: ON LS Fc 50 Hz Gain 2.0 dB Q 0.71
 *   Filter 3: ON HS Fc 8000 Hz Gain 1.2 dB Q 0.71
 */

export interface EQBand {
  type: 'peaking' | 'lowShelf' | 'highShelf'
  frequency: number
  gain: number
  q: number
}

export interface AutoEQProfile {
  name: string
  bands: EQBand[]
  preampGain: number
}

const TYPE_MAP: Record<string, EQBand['type']> = {
  PK: 'peaking',
  LS: 'lowShelf',
  HS: 'highShelf',
}

export function parseAutoEQ(text: string, name = 'Custom'): AutoEQProfile {
  const bands: EQBand[] = []
  let preampGain = 0

  for (const line of text.split('\n')) {
    const preampMatch = line.match(/Preamp:\s*([-\d.]+)\s*dB/i)
    if (preampMatch) {
      preampGain = parseFloat(preampMatch[1])
      continue
    }

    const filterMatch = line.match(
      /ON\s+(PK|LS|HS)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+Q\s+([\d.]+)/i
    )
    if (filterMatch) {
      bands.push({
        type: TYPE_MAP[filterMatch[1].toUpperCase()] ?? 'peaking',
        frequency: parseFloat(filterMatch[2]),
        gain: parseFloat(filterMatch[3]),
        q: parseFloat(filterMatch[4]),
      })
    }
  }

  return { name, bands, preampGain }
}
