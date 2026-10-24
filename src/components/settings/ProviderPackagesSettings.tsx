import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { GlassPanel, SOLID_GLASS_TINT } from '../GlassPanel'
import { useProviderStatusStore } from '../../store/providerStatusStore'
import type { InstalledProviderPackageInfo, PackageInspectionSummary, RetainedProviderData } from '../../../electron/preload'
import { describePublisher, describeRelation, describeTrustWarning, needsIncompatibilityConfirmation } from './providerPackageText'
import { Button } from '../ui'
import { Switch } from './controls'

/** Long lists (e.g. one sign-in origin per Google country domain) show the rest on demand. */
const PERMISSION_PREVIEW = 8

function PermissionList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  const entry = (item: string) => <li key={item} className="break-all font-mono">{item}</li>
  const hidden = items.slice(PERMISSION_PREVIEW + 1)
  return (
    <div className="mt-2">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
      <ul className="mt-1 space-y-0.5 text-xs text-zinc-300">
        {(hidden.length > 0 ? items.slice(0, PERMISSION_PREVIEW) : items).map(entry)}
      </ul>
      {hidden.length > 0 && (
        <details className="mt-0.5 text-xs text-zinc-300">
          <summary className="cursor-pointer text-zinc-500">+{items.length - PERMISSION_PREVIEW} more</summary>
          <ul className="mt-0.5 space-y-0.5">{items.slice(PERMISSION_PREVIEW).map(entry)}</ul>
        </details>
      )}
    </div>
  )
}

function ConsentDialog({
  summary,
  onCancel,
  onInstall,
}: {
  summary: PackageInspectionSummary
  onCancel: () => void
  onInstall: () => Promise<void>
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmIncompatible, setConfirmIncompatible] = useState(false)
  const [installing, setInstalling] = useState(false)
  const alreadyInstalled = summary.relation === 'same'
  const isUpdate = summary.installedVersion !== null

  const install = async () => {
    setInstalling(true)
    try {
      await onInstall()
    } finally {
      setInstalling(false)
    }
  }

  // At the document root: the settings modal's glass would otherwise contain and clip it.
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true" data-testid="provider-package-consent">
      <GlassPanel radius={12} tint={SOLID_GLASS_TINT} className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto border border-transparent p-5">
        <p className="text-xs text-zinc-500">{describeRelation(summary)}</p>
        <h4 className="mt-1 text-base font-semibold text-zinc-100">{summary.displayName} <span className="text-sm font-normal text-zinc-500">v{summary.version}</span></h4>
        {isUpdate && !alreadyInstalled && <p className="mt-2 text-xs text-zinc-300">v{summary.installedVersion} → v{summary.version}. Your library, playlists, settings and sign-in are kept.</p>}
        {summary.description && <p className="mt-1 text-xs text-zinc-400">{summary.description}</p>}
        <p className={`mt-3 text-xs ${summary.trust.signature === 'unsigned' ? 'text-amber-300' : 'text-zinc-300'}`}>{describePublisher(summary)}</p>

        <PermissionList label="Capabilities" items={summary.capabilities} />
        <PermissionList label="Network" items={summary.permissions.networkOrigins} />
        <PermissionList label="Opens in browser" items={summary.permissions.externalOrigins} />
        <PermissionList label="Sign-in pages" items={summary.permissions.authOrigins} />
        <PermissionList label="Native programs" items={summary.permissions.helpers.map((helper) => `${helper.id}: ${helper.executable}`)} />
        <PermissionList label="Stored secrets" items={summary.permissions.secrets} />
        <PermissionList label="Environment variables" items={summary.permissions.runtimeEnvironment} />

        <ul className="mt-4 space-y-2" data-testid="provider-package-warnings">
          {summary.trust.warnings.map((warning) => (
            <li key={warning} className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-100">{describeTrustWarning(warning, summary)}</li>
          ))}
        </ul>

        {!alreadyInstalled && (
          <label className="mt-4 flex items-start gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5"
              data-testid="provider-package-acknowledge"
            />
            <span>I understand these warnings and trust this provider with my account.</span>
          </label>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" label="Cancel" disabled={installing} onClick={onCancel} />
          <Button
            variant="secondary"
            size="sm"
            label={installing ? (isUpdate ? 'Updating…' : 'Installing…') : alreadyInstalled ? 'Done' : isUpdate ? 'Update' : 'Install'}
            disabled={(!acknowledged && !alreadyInstalled) || installing}
            onClick={() => {
              if (needsIncompatibilityConfirmation(summary)) setConfirmIncompatible(true)
              else void install()
            }}
            data-testid="provider-package-install"
          />
        </div>
      </GlassPanel>

      {confirmIncompatible && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-6" role="alertdialog" aria-modal="true" data-testid="provider-package-incompatible">
          <GlassPanel radius={12} tint={SOLID_GLASS_TINT} className="relative w-full max-w-sm border border-amber-400/30 p-5">
            <h4 className="text-sm font-semibold text-amber-200">This plugin version may be incompatible</h4>
            <p className="mt-2 text-xs text-zinc-300">
              {summary.relation === 'downgrade'
                ? `Version ${summary.version} is older than the installed ${summary.installedVersion}.`
                : `Puros cannot tell how version ${summary.version} relates to the installed ${summary.installedVersion}.`}
              {' '}It may not work with this version of Puros or with data saved by the installed version. Your provider data is kept either way.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Cancel" onClick={() => setConfirmIncompatible(false)} />
              <Button
                variant="secondary"
                size="sm"
                label={isUpdate ? 'Update anyway' : 'Install anyway'}
                disabled={installing}
                onClick={() => { setConfirmIncompatible(false); void install() }}
                data-testid="provider-package-install-anyway"
              />
            </div>
          </GlassPanel>
        </div>
      )}
    </div>,
    document.body,
  )
}

function PackageRow({ item, onChanged, onMessage, onUpdate, choosing }: {
  item: InstalledProviderPackageInfo
  onChanged: () => Promise<void>
  onMessage: (message: string) => void
  onUpdate: () => void
  choosing: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const run = async (operation: () => Promise<{ ok: boolean; error?: string; value?: unknown }>) => {
    setBusy(true)
    try {
      const result = await operation()
      if (!result.ok) onMessage(result.error ?? 'The operation failed')
      else {
        const outcome = result.value as { error?: string } | undefined
        if (outcome?.error) onMessage(`${item.displayName} could not start: ${outcome.error}`)
      }
      await onChanged()
    } finally {
      setBusy(false)
    }
  }
  const signature = item.signature === 'first-party' ? 'Verified by Puros'
    : item.signature === 'publisher' ? `Publisher ${item.publisherFingerprint}` : 'Unsigned'

  return (
    <div className="rounded-2xl bg-white/[0.03] p-4" data-testid={`provider-package-row-${item.providerId}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">{item.displayName} <span className="text-xs font-normal text-zinc-500">v{item.version}</span></p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {signature} · {item.enabled ? (item.state ?? 'not running') : 'disabled'}
            {item.previousVersion ? ` · previous v${item.previousVersion} kept` : ''}
          </p>
          {item.lastError && <p className="mt-1 text-xs text-red-300">{item.lastError}</p>}
        </div>
        <Switch
          checked={item.enabled}
          disabled={busy || choosing}
          onChange={(enabled) => { void run(() => window.puros.providerPackages.setEnabled(item.providerId, enabled)) }}
          label={`Enable ${item.displayName}`}
          title={item.enabled ? 'Enabled' : 'Disabled'}
          testId={`provider-package-toggle-${item.providerId}`}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-white/5 pt-3">
        <Button
          variant="secondary"
          size="sm"
          label="Update from file…"
          disabled={busy || choosing}
          onClick={onUpdate}
          data-testid={`provider-package-update-${item.providerId}`}
        />
        {removeConfirm ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-300">Remove this provider&apos;s code? Its library, settings, sessions and cache stay until you remove its data.</p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="xs" label="Cancel" onClick={() => setRemoveConfirm(false)} />
              <Button
                variant="danger"
                size="xs"
                label="Remove code"
                disabled={busy}
                onClick={() => { void run(() => window.puros.providerPackages.removeCode(item.providerId)) }}
                data-testid={`provider-package-remove-confirm-${item.providerId}`}
              />
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy || choosing}
            onClick={() => setRemoveConfirm(true)}
            className="text-xs text-red-300/80 hover:text-red-200 disabled:opacity-40"
            data-testid={`provider-package-remove-${item.providerId}`}
          >Remove provider code…</button>
        )}
      </div>
    </div>
  )
}

function describeRetained(entry: RetainedProviderData): string {
  const parts = [
    [entry.tracks, 'track'], [entry.albums, 'album'], [entry.artists, 'artist'], [entry.playlists, 'playlist'],
    [entry.cacheEntries, 'cached file'], [entry.catalogLinks, 'catalog link'], [entry.privateEntries, 'setting or sign-in entry'],
  ] as const
  return parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}${count === 1 ? '' : 's'}`).join(', ')
}

/** Data kept for providers that are not running here: disabled packages, removed code, or providers absent from this build. */
function RetainedDataRow({ entry, name, installed, onRemoved }: {
  entry: RetainedProviderData
  name: string
  installed: boolean
  onRemoved: (message: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  return (
    <div className="rounded-2xl bg-white/[0.03] p-4" data-testid={`retained-data-row-${entry.providerId}`}>
      <p className="text-sm text-zinc-200">{name} <span className="text-xs text-zinc-500">{installed ? 'installed, not running' : 'code not installed'}</span></p>
      <p className="mt-1 text-xs text-zinc-500">{describeRetained(entry)}</p>
      <div className="mt-3">
        {confirming ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-red-200">Delete this provider&apos;s imported library, sign-in, settings and cache? Cached audio cannot be recovered.</p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="xs" label="Cancel" onClick={() => setConfirming(false)} />
              <Button
                variant="danger"
                size="xs"
                label={removing ? 'Removing…' : 'Remove all data'}
                disabled={removing}
                onClick={() => {
                  setRemoving(true)
                  void window.puros.provider.removeData(entry.providerId)
                    .then(() => onRemoved(`Removed all data stored for ${name}.`))
                    .catch((error: unknown) => onRemoved(`Could not remove ${name} data: ${error instanceof Error ? error.message : String(error)}`))
                    .finally(() => setRemoving(false))
                }}
                data-testid={`retained-data-remove-confirm-${entry.providerId}`}
              />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-xs text-red-300/80 hover:text-red-200"
            data-testid={`retained-data-remove-${entry.providerId}`}
          >Remove all provider data…</button>
        )}
      </div>
    </div>
  )
}

/** Settings section for providers installed from ZIP packages at runtime. */
export default function ProviderPackagesSettings() {
  const loadProviders = useProviderStatusStore((state) => state.loadProviders)
  const [packages, setPackages] = useState<InstalledProviderPackageInfo[]>([])
  const [retained, setRetained] = useState<RetainedProviderData[]>([])
  const [inspection, setInspection] = useState<PackageInspectionSummary | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.puros.providerPackages.list()
    if (result.ok) setPackages(result.value)
    else setMessage(result.error)
    setRetained(await window.puros.provider.retainedData().catch(() => []))
    await loadProviders()
  }, [loadProviders])

  useEffect(() => { void refresh() }, [refresh])

  const choose = async (item?: InstalledProviderPackageInfo) => {
    setMessage(null)
    setChoosing(true)
    try {
      const result = await window.puros.providerPackages.choose(item?.providerId)
      if (!result.ok) setMessage(`${item ? 'This update' : 'This package'} cannot be installed: ${result.error}`)
      else if (result.value) setInspection(result.value)
    } catch (error) {
      setMessage(`Could not open the package: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setChoosing(false)
    }
  }

  const close = () => {
    if (inspection) void window.puros.providerPackages.discard(inspection.token)
    setInspection(null)
  }

  const install = async () => {
    if (!inspection) return
    const isUpdate = inspection.installedVersion !== null
    try {
      const result = await window.puros.providerPackages.install(inspection.token, inspection.trust.warnings)
      if (!result.ok) {
        setMessage(`${isUpdate ? 'Update' : 'Installation'} failed: ${result.error}`)
        void window.puros.providerPackages.discard(inspection.token)
      } else if (result.value.rolledBack) setMessage(`${inspection.displayName} v${inspection.version} could not start and was rolled back: ${result.value.error ?? 'unknown error'}`)
      else if (result.value.error) setMessage(`${inspection.displayName} was ${isUpdate ? 'updated' : 'installed'} but could not start: ${result.value.error}`)
      else setMessage(`${inspection.displayName} ${result.value.status === 'already-installed' ? `v${inspection.version} is already installed` : isUpdate ? `was updated from v${inspection.installedVersion} to v${inspection.version}` : `v${inspection.version} is installed`}.`)
    } catch (error) {
      setMessage(`${isUpdate ? 'Update' : 'Installation'} failed: ${error instanceof Error ? error.message : String(error)}`)
      void window.puros.providerPackages.discard(inspection.token)
    } finally {
      setInspection(null)
    }
    await refresh()
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-[0.22em] text-zinc-400">Installed provider packages</h3>
        <Button
          variant="secondary"
          size="sm"
          label={choosing ? 'Checking package…' : 'Install provider…'}
          disabled={choosing}
          onClick={() => { void choose() }}
          data-testid="install-provider-button"
        />
      </div>
      {message && <p className="mb-3 rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-zinc-300" data-testid="provider-package-message">{message}</p>}
      <div className="space-y-3">
        {packages.map((item) => <PackageRow key={item.providerId} item={item} onChanged={refresh} onMessage={setMessage} onUpdate={() => { void choose(item) }} choosing={choosing} />)}
        {packages.length === 0 && (
          <p className="rounded-2xl bg-white/[0.03] px-4 py-3 text-xs text-zinc-500">
            No provider packages installed. Packages are ZIP files built with <span className="font-mono">npm run providers:pack</span>.
          </p>
        )}
      </div>
      {retained.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-3 text-[11px] uppercase tracking-[0.22em] text-zinc-400">Data from inactive providers</h3>
          <div className="space-y-3">
            {retained.map((entry) => {
              const installedPackage = packages.find((item) => item.providerId === entry.providerId)
              return (
                <RetainedDataRow
                  key={entry.providerId}
                  entry={entry}
                  name={installedPackage?.displayName ?? entry.providerId}
                  installed={Boolean(installedPackage)}
                  onRemoved={async (text) => { setMessage(text); await refresh() }}
                />
              )
            })}
          </div>
        </div>
      )}
      {inspection && <ConsentDialog summary={inspection} onCancel={close} onInstall={install} />}
    </div>
  )
}
