// WP-332: one-shot grants for the destructive-action gate. The user's "Allow once" on a gate card (an ask, answered through the
// normal ask flow) mints a grant for (pane, command hash); the agent's retry consumes it. No route creates a grant: only an
// answered gate ask does, and answering is the user's alone. Table wt_gate_grants (store.mjs migration). Not exported.
import { join } from 'node:path'
import { open } from './store.mjs'

export const GRANT_MS = 10 * 60_000
// WP-332 (c): may a verified reply act as the user's word for the gate? Receiver is an orchestrator, that orchestrator handed
// this ticket off, and the reply comes from the card's CURRENT assignee (a former or other agent's reply stays gated).
export const replyMayAct = ({ receiverRole, handedByReceiver, assigneePane, senderPane }) =>
  receiverRole === 'orchestrator' && handedByReceiver === true && !!assigneePane && assigneePane === senderPane
export class Gate {
  constructor({ dir, now = Date.now, log = console.error }) { Object.assign(this, { file: join(dir, 'wt.db'), now, log }) }
  get db() { return open(this.file, { log: this.log }) }
  grant(pane, hash) {
    this.db.prepare('INSERT OR REPLACE INTO wt_gate_grants (pane, hash, expires) VALUES (?, ?, ?)').run(pane, hash, this.now() + GRANT_MS)
  }
  // → true once for a live grant, then it is gone.
  consume(pane, hash) {
    this.db.prepare('DELETE FROM wt_gate_grants WHERE expires < ?').run(this.now())
    return this.db.prepare('DELETE FROM wt_gate_grants WHERE pane = ? AND hash = ? AND expires >= ?').run(pane, hash, this.now()).changes > 0
  }
}
