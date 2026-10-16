export const kTransportBluetooth = 0x626C7565
export const kTransportBluetoothLE = 0x626C6561
export const kTransportAirPlay = 0x61697270

export type ExclusiveBlockedTransport = 'BLUETOOTH_DEVICE' | 'AIRPLAY_DEVICE' | null

export function isBluetoothTransport(transportType?: number | null): boolean {
  return transportType === kTransportBluetooth || transportType === kTransportBluetoothLE
}

export function isAirPlayTransport(transportType?: number | null): boolean {
  return transportType === kTransportAirPlay
}

export function isSharedOnlyTransport(transportType?: number | null): boolean {
  return isBluetoothTransport(transportType) || isAirPlayTransport(transportType)
}

export function getTransportLabel(transportType?: number | null): string | null {
  if (isAirPlayTransport(transportType)) return 'AirPlay'
  if (isBluetoothTransport(transportType)) return 'Bluetooth'
  return null
}

export function getExclusiveBlockedTransportError(transportType?: number | null): ExclusiveBlockedTransport {
  if (isAirPlayTransport(transportType)) return 'AIRPLAY_DEVICE'
  if (isBluetoothTransport(transportType)) return 'BLUETOOTH_DEVICE'
  return null
}

export function getExclusiveBlockedTransportLabel(error?: string | null): string | null {
  if (error === 'AIRPLAY_DEVICE') return 'AirPlay'
  if (error === 'BLUETOOTH_DEVICE') return 'Bluetooth'
  return null
}
