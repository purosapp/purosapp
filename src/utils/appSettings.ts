export async function getStringSetting(key: string): Promise<string | null> {
  try {
    return await window.puros.settings.get(key)
  } catch {
    return null
  }
}

export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const raw = await getStringSetting(key)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

export async function getJsonSetting<T>(key: string, fallback: T): Promise<T> {
  const raw = await getStringSetting(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function setStringSetting(key: string, value: string): Promise<void> {
  await window.puros.settings.set(key, value)
}

export async function deleteSetting(key: string): Promise<void> {
  await window.puros.settings.delete(key)
}

export async function setBooleanSetting(key: string, value: boolean): Promise<void> {
  await setStringSetting(key, value ? 'true' : 'false')
}

export async function setJsonSetting(key: string, value: unknown): Promise<void> {
  await setStringSetting(key, JSON.stringify(value))
}
