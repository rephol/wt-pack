// Esc → Skip cancels the question in the terminal, with no undo. It may ONLY come from an explicit Esc keypress
// while the question card itself has focus, not from a text field, and never while a send is in flight.
// (Never on unmount/blur/transition: nothing else calls skip.)
export interface SkipKey { key: string; cardHasFocus: boolean; inFlight: boolean; targetIsTextField: boolean }
export const isUserSkip = (e: SkipKey) => e.key === 'Escape' && e.cardHasFocus && !e.inFlight && !e.targetIsTextField
