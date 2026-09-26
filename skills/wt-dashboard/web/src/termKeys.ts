// What a keystroke in the xterm mirror sends: a whitelisted key name, literal text, or nothing.
const SEQ: Record<string, string> = {
  '\r': 'Enter', '\t': 'Tab', '\x1b': 'Esc', '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
  '\x7f': 'Backspace', '\b': 'Backspace', '\x03': 'C-c', '\x04': 'C-d', '\x1a': 'C-z', '\x0c': 'C-l',
  '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown', '\x1b[H': 'Home', '\x1b[F': 'End', '\x1bOH': 'Home', '\x1bOF': 'End',
}
export type TermInput = { keys: string[] } | { text: string } | null
export function termInput(data: string): TermInput {
  if (SEQ[data]) return { keys: [SEQ[data]] }
  // Printable text, including a multi-line paste (xterm hands a paste over as one string with \r).
  if (/^[^\x00-\x08\x0b-\x1f\x7f]+$/.test(data.replace(/\r\n?/g, '\n'))) return { text: data.replace(/\r\n?/g, '\n') }
  return null // other control sequences (F-keys, alt-combos): not on the whitelist
}
