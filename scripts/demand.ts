// The demand ledger, read back: what outsiders paid to read, by node and by type.
//
//   bun run scripts/demand.ts [ledger.jsonl] [--collective birdbrain] [--top 20]
//
// Each paid query's amount is shared equally across the distinct nodes its rows
// contained. That is a demand signal, not a contribution score and not a payout:
// ADR 0034 keeps the two records apart and leaves the split to members.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const slug = arg("--collective") ?? "birdbrain";
const top = Number(arg("--top") ?? "20");
const path = process.argv.slice(2).find((a) => a.endsWith(".jsonl")) ?? join(ROOT, "state", `${slug}-demand.jsonl`);
if (!existsSync(path)) {
  console.log(`no demand ledger at ${path}: no paid query has been recorded yet`);
  process.exit(0);
}

const cfg = JSON.parse(readFileSync(join(ROOT, "collectives", `${slug}.json`), "utf8"));
const db = new Database(join(ROOT, cfg.db.full), { readonly: true });
const label = (k: string): { type: string; label: string } => {
  const v = db.query("SELECT type, label FROM vertices WHERE key = ?").get(k) as any;
  if (v) return { type: v.type, label: v.label ?? k };
  const c = db.query("SELECT name FROM concepts WHERE id = ?").get(k) as any;
  return c ? { type: "concept (extracted)", label: c.name ?? k } : { type: "?", label: k };
};

const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const byNode = new Map<string, { dusd: number; queries: number; rows: number }>();
let total = 0, unattributed = 0;
for (const e of lines) {
  const paid = Number(e.paid_dusd);
  total += paid;
  const keys = Object.keys(e.nodes ?? {});
  if (!keys.length) { unattributed += paid; continue; }
  for (const k of keys) {
    const n = byNode.get(k) ?? { dusd: 0, queries: 0, rows: 0 };
    n.dusd += paid / keys.length;
    n.queries += 1;
    n.rows += e.nodes[k];
    byNode.set(k, n);
  }
}

const byType = new Map<string, number>();
for (const [k, n] of byNode) {
  const t = label(k).type;
  byType.set(t, (byType.get(t) ?? 0) + n.dusd);
}

const f = (x: number) => x.toFixed(4);
console.log(`${lines.length} paid queries, ${f(total)} dUSD, ${f(unattributed)} dUSD returned no graph node`);
console.log(`\nby type`);
for (const [t, d] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${f(d).padStart(9)}  ${t}`);
console.log(`\ntop ${top} nodes (dUSD share · queries · rows)`);
for (const [k, n] of [...byNode].sort((a, b) => b[1].dusd - a[1].dusd).slice(0, top)) {
  const l = label(k);
  console.log(`  ${f(n.dusd).padStart(9)}  ${String(n.queries).padStart(3)}  ${String(n.rows).padStart(4)}  ${l.type}: ${l.label}`);
}
