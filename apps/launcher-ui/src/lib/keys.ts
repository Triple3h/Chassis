/** ⌘/Ctrl 归一化 + 快捷键表（requirements §3.2） */

export const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)

export interface KeyChord {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

export function parseEvent(e: KeyboardEvent): KeyChord {
  return {
    mod: isMac ? e.metaKey : e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
  }
}

export function matchChord(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split('+')
  const wantMod = parts.includes('Mod')
  const wantShift = parts.includes('Shift')
  const wantAlt = parts.includes('Alt')
  const keyName = parts.filter((p) => !['Mod', 'Shift', 'Alt'].includes(p))[0] ?? ''
  const chord = parseEvent(e)
  if (chord.mod !== wantMod || chord.shift !== wantShift || chord.alt !== wantAlt) return false
  const normalized = keyName.length === 1 ? keyName.toLowerCase() : keyName
  const eventKey = chord.key
  if (normalized === 'Enter') return eventKey === 'Enter'
  if (normalized === 'Escape') return eventKey === 'Escape'
  if (normalized === 'Tab') return eventKey === 'Tab'
  if (normalized === 'ArrowUp') return eventKey === 'ArrowUp'
  if (normalized === 'ArrowDown') return eventKey === 'ArrowDown'
  if (normalized === 'ArrowLeft') return eventKey === 'ArrowLeft'
  if (normalized === 'ArrowRight') return eventKey === 'ArrowRight'
  return eventKey === normalized
}

/** 展示用：`Mod+K` → `⌘K` */
export function formatKeys(keys: string[] | undefined): string[] {
  if (!keys || keys.length === 0) return []
  return keys
    .join('+')
    .split('+')
    .map((part) => {
      if (part === 'Mod') return isMac ? '⌘' : 'Ctrl'
      if (part === 'Shift') return isMac ? '⇧' : 'Shift'
      if (part === 'Alt') return isMac ? '⌥' : 'Alt'
      if (part === 'Enter') return '↵'
      if (part === 'Escape') return 'Esc'
      if (part === 'ArrowUp') return '↑'
      if (part === 'ArrowDown') return '↓'
      if (part === 'ArrowLeft') return '←'
      if (part === 'ArrowRight') return '→'
      return part
    })
}

export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      const map: Record<string, string> = {
        Alt: isMac ? '⌥' : 'Alt',
        Option: isMac ? '⌥' : 'Alt',
        Command: isMac ? '⌘' : 'Win',
        Cmd: isMac ? '⌘' : 'Win',
        Control: isMac ? '⌃' : 'Ctrl',
        Ctrl: isMac ? '⌃' : 'Ctrl',
        Shift: isMac ? '⇧' : 'Shift',
        Super: '⌘',
        Space: 'Space',
      }
      return map[part] ?? part
    })
    .join('')
}
