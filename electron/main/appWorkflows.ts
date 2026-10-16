import {
  app,
  clipboard,
  shell,
  type BrowserWindow,
} from 'electron'
import { normalizeHttpExternalUrl } from './security/urlPolicy'

export function getAppUserDataPath(): string {
  return app.getPath('userData')
}

export function isAppFullScreen(getMainWindow: () => BrowserWindow | null): boolean {
  return getMainWindow()?.isFullScreen() ?? false
}

export function toggleAppFullScreen(getMainWindow: () => BrowserWindow | null): boolean {
  const win = getMainWindow()
  if (!win) return false

  const next = !win.isFullScreen()
  win.setFullScreen(next)
  return next
}

export function openAppExternal(url: string) {
  const allowedUrl = normalizeHttpExternalUrl(url)
  if (!allowedUrl) throw new TypeError('Only HTTP and HTTPS URLs may be opened externally')
  return shell.openExternal(allowedUrl)
}

export function copyAppTextToClipboard(text: string): void {
  clipboard.writeText(text ?? '')
}

export async function openAppAirplayPicker(
  openSystemSoundOutputPicker: () => Promise<unknown>,
) {
  try {
    await openSystemSoundOutputPicker()
    return {
      success: true,
      method: 'system-picker' as const,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const requiresAccessibilityPermission =
      message.includes('-1719') ||
      /assistive|accessibility|wspomaganego/i.test(message)

    await shell.openExternal('x-apple.systempreferences:com.apple.Sound-Settings.extension')

    return {
      success: false,
      method: 'sound-settings' as const,
      requiresAccessibilityPermission,
      message: requiresAccessibilityPermission
        ? 'macOS blocked one-click AirPlay browsing. Sound settings were opened instead.'
        : 'Could not open the one-click AirPlay picker. Sound settings were opened instead.',
    }
  }
}
