import { app } from 'electron'
import { createHash } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import type { LastFmMethod } from '../../../src/services/lastfm/types'
import { getMainWindow } from '../rendererBridge'
import { getLastFmCredentials } from './config'

export type LastFmApiCallPayload = {
  method: LastFmMethod
  params: Record<string, string>
  sessionKey?: string
  sign?: boolean
  useSessionKey?: boolean
}

let pendingLastFmAuthToken: string | null = null
let lastFmCallbackServer: http.Server | null = null

function sendLastFmAuthToken(token: string) {
  const win = getMainWindow()
  if (!win || win.webContents.isDestroyed() || win.webContents.isLoading()) {
    pendingLastFmAuthToken = token
    return
  }

  win.webContents.send('lastfm:auth-token', token)
}

export function flushPendingLastFmAuthToken() {
  if (!pendingLastFmAuthToken) return
  const token = pendingLastFmAuthToken
  pendingLastFmAuthToken = null
  sendLastFmAuthToken(token)
}

export function clearPendingLastFmAuthToken() {
  pendingLastFmAuthToken = null
}

export function handleLastFmCallbackUrl(rawUrl: string): boolean {
  if (!rawUrl.startsWith('puros://lastfm/callback')) return false

  try {
    const token = new URL(rawUrl).searchParams.get('token')
    if (token) sendLastFmAuthToken(token)
    return true
  } catch (error) {
    console.warn('[LastFm] Failed to parse auth callback:', error)
    return true
  }
}

export function registerLastFmProtocolHandler() {
  try {
    const proc = process as NodeJS.Process & { defaultApp?: boolean }
    if (proc.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('puros', process.execPath, [path.resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient('puros')
    }
  } catch (error) {
    console.warn('[LastFm] Failed to register puros:// protocol handler:', error)
  }
}

function generateLastFmSignature(params: Record<string, string>, apiSecret: string): string {
  const signatureString = Object.keys(params)
    .filter((key) => key !== 'format' && key !== 'callback' && key !== 'api_sig')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('') + apiSecret

  return createHash('md5').update(signatureString).digest('hex')
}

export async function callLastFmApi(payload: LastFmApiCallPayload): Promise<unknown> {
  const { apiKey, apiSecret } = getLastFmCredentials()
  const shouldSign = payload.sign !== false

  if (!apiKey) throw new Error('Last.fm API key is missing')
  if (shouldSign && !apiSecret) throw new Error('Last.fm API secret is missing')

  const params: Record<string, string> = {
    method: payload.method,
    api_key: apiKey,
    format: 'json',
  }

  for (const [key, value] of Object.entries(payload.params ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      params[key] = String(value)
    }
  }

  if (payload.useSessionKey !== false && payload.sessionKey) {
    params.sk = payload.sessionKey
  }

  if (shouldSign) {
    params.api_sig = generateLastFmSignature(params, apiSecret!)
  }

  const response = await fetch('https://ws.audioscrobbler.com/2.0/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })

  if (!response.ok) {
    throw new Error(`Last.fm API error: ${response.status}`)
  }

  const data = await response.json() as { error?: number; message?: string }
  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message ?? 'Unknown error'}`)
  }

  return data
}

export async function startLastFmCallbackServer(): Promise<number> {
  lastFmCallbackServer?.close()
  lastFmCallbackServer = null

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const token = new URL(req.url ?? '/', `http://localhost`).searchParams.get('token')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body style="font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Authorized — you can close this tab and return to Puros.</p></body></html>')
      server.close()
      lastFmCallbackServer = null
      if (token) sendLastFmAuthToken(token)
    })
    server.listen(0, '127.0.0.1', () => {
      lastFmCallbackServer = server
      resolve((server.address() as { port: number }).port)
    })
    server.on('error', reject)
  })
}

export function getLastFmAuthUrl(callbackPort: number): string | null {
  const { apiKey } = getLastFmCredentials()
  if (!apiKey) return null

  const callback = encodeURIComponent(`http://localhost:${callbackPort}/lastfm/callback`)
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&cb=${callback}`
}

export async function getLastFmAuthenticationUrl(): Promise<string | null> {
  const port = await startLastFmCallbackServer()
  return getLastFmAuthUrl(port)
}

export function getLastFmConfigStatus() {
  const { apiKey, apiSecret } = getLastFmCredentials()
  return {
    configured: !!apiKey && !!apiSecret,
  }
}

export function completeLastFmAuth() {
  return { success: true }
}
