/**
 * Tracks a service lists but the signed-in account cannot stream. Providers
 * report a reason (`ProviderTrackUnavailableReasonV1`) on listings or when
 * playback fails; core greys those rows and keeps them out of queues.
 */

import type { ProviderErrorV1 } from '../provider-api/v1'

const LABELS: Record<string, string> = {
  region: 'Not available in your country',
  subscription: 'Not included in your plan',
  removed: 'No longer available',
  unreleased: 'Not released yet',
  unsupported: 'Puros cannot play this track’s stream',
}

/** Tooltip and notice text for a greyed-out track. */
export function unavailableTrackLabel(reason: string | null | undefined): string {
  return (reason && LABELS[reason]) || 'Not available'
}

/**
 * The reason a failed `resolve`/`prefetch` means the track itself cannot be
 * streamed, or null for failures worth retrying (network, auth, timeouts).
 * `NOT_FOUND` counts too: providers built before `TRACK_UNAVAILABLE` used it
 * for region locks and takedowns.
 */
export function unavailableReasonFromProviderError(error: Pick<ProviderErrorV1, 'code' | 'details'>): string | null {
  if (error.code === 'TRACK_UNAVAILABLE') {
    const reason = error.details?.reason
    return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 32) : 'other'
  }
  return error.code === 'NOT_FOUND' ? 'other' : null
}
