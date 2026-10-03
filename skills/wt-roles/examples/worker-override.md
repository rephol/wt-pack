Run `npm test` and `npx tsc --noEmit` before every commit; a red check is never "unrelated" until you have
shown it fails on main too.

- Migrations live in `db/migrations/`; never edit a merged one, add a new one.
- Keep commits small: one logical change each, message in the imperative.
- The staging database is shared. Never run destructive scripts against it; use the local compose stack.
