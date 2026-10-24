import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, Menu: {} }))
vi.mock('./rendererBridge', () => ({ getMainWindow: () => null }))

const { buildDockMenuTemplate, sanitizeDockMenuState } = await import('./dockMenu')

const playing = {
  hasTrack: true,
  isPlaying: true,
  shuffle: false,
  repeat: 'one' as const,
  recents: [{ id: 'local:4', title: 'Rabit' }, { id: 'provider:spotify:playlist:x:y', title: 'Ulubione na zawsze' }],
}

describe('Dock menu', () => {
  it('lists playback controls, shuffle / repeat and recently played above the system items', () => {
    const command = vi.fn()
    const openRecent = vi.fn()
    const template = buildDockMenuTemplate(playing, { command, openRecent }, true)
    expect(template.map((item) => item.type === 'separator' ? '—' : item.label)).toEqual([
      'Pause', '—', 'Next', 'Previous', '—', 'Shuffle', 'Repeat One', '—', 'Recently Played', 'Rabit', 'Ulubione na zawsze',
    ])
    expect(template.find((item) => item.label === 'Recently Played')?.type).toBe('header')
    expect(template.find((item) => item.label === 'Shuffle')).toMatchObject({ type: 'checkbox', checked: false })
    expect(template.find((item) => item.label === 'Repeat One')).toMatchObject({ type: 'checkbox', checked: true })

    const click = (label: string) => (template.find((item) => item.label === label)?.click as () => void)()
    click('Pause')
    click('Next')
    click('Shuffle')
    click('Repeat One')
    click('Ulubione na zawsze')
    expect(command.mock.calls.map(([name]) => name)).toEqual(['play-pause', 'next', 'toggle-shuffle', 'cycle-repeat'])
    expect(openRecent).toHaveBeenCalledWith('provider:spotify:playlist:x:y')
  })

  it('disables transport without a track, and drops the recents section when empty', () => {
    const template = buildDockMenuTemplate(
      { ...playing, hasTrack: false, isPlaying: false, repeat: 'off', recents: [] },
      { command: vi.fn(), openRecent: vi.fn() },
      false,
    )
    expect(template.find((item) => item.label === 'Play')?.enabled).toBe(false)
    expect(template.find((item) => item.label === 'Next')?.enabled).toBe(false)
    expect(template.find((item) => item.label === 'Repeat')?.checked).toBe(false)
    expect(template.some((item) => item.label === 'Recently Played')).toBe(false)
  })

  it('accepts only well-formed state from the renderer', () => {
    expect(sanitizeDockMenuState(null)).toBeNull()
    const state = sanitizeDockMenuState({
      hasTrack: 'yes',
      isPlaying: true,
      repeat: 'forever',
      recents: [
        { id: 'a', title: 'x'.repeat(100) },
        { id: 1, title: 'bad' },
        { id: 'b', title: '   ' },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, title: `P${i}` })),
      ],
    })
    expect(state).toMatchObject({ hasTrack: false, isPlaying: true, shuffle: false, repeat: 'off' })
    expect(state?.recents).toHaveLength(5)
    expect(state?.recents[0].title).toHaveLength(60)
  })
})
