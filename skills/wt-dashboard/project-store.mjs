// WP-347: the dashboard's own list of projects (name → main checkout) in wt.db, so a project stays listed with no running
// agent or herdr workspace. projectRoots() adds every project it derives and reads the rest back from here.
export class ProjectStore {
  // open: () => db, called on first use so importing the server (tests) opens nothing.
  constructor(open) { this.open = open }
  get db() {
    if (!this._db) { this._db = this.open(); this._db.exec('CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, root TEXT NOT NULL, added_at INTEGER NOT NULL)') }
    return this._db
  }
  all() { return new Map(this.db.prepare('SELECT name, root FROM projects ORDER BY added_at').all().map((r) => [r.name, r.root])) }
  // A known name keeps its first row unless the checkout moved.
  add(name, root, at = Date.now()) {
    const cur = this.db.prepare('SELECT root FROM projects WHERE name = ?').get(name)
    if (!cur) this.db.prepare('INSERT INTO projects (name, root, added_at) VALUES (?, ?, ?)').run(name, root, at)
    else if (cur.root !== root) this.db.prepare('UPDATE projects SET root = ? WHERE name = ?').run(root, name)
  }
}
