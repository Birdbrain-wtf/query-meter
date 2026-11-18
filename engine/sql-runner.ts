// One buyer query, in its own process, so the meter can kill it.
//
// bun:sqlite has no statement timeout and a blocked native call cannot be
// interrupted from JS, so a cross join from a stranger would otherwise hold
// the server. The server spawns this per query with a deadline and kills it.
//
// stdin: {"db": "/path.db", "sql": "SELECT …", "mode": "count"|"rows", "limit": 500}
// stdout: {"n": 12} or {"rows": [...]}, or {"error": "…"} with exit 1.

import { Database } from "bun:sqlite";

const input = JSON.parse(await Bun.stdin.text());
try {
  const db = new Database(input.db, { readonly: true });
  if (input.mode === "count") {
    const r = db.query(`SELECT count(*) AS n FROM (${input.sql})`).get() as { n: number };
    process.stdout.write(JSON.stringify({ n: r.n }));
  } else {
    const limit = Math.max(0, Math.min(Number(input.limit) || 0, 5000));
    const rows = db.query(`SELECT * FROM (${input.sql}) LIMIT ${limit}`).all();
    process.stdout.write(JSON.stringify({ rows }));
  }
} catch (e: any) {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exit(1);
}
