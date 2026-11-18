// The Birdbrain corpus as sold to anyone: the graph, without the speech.
//
// Reads lab/birdbrain-402/out/{birdbrain,sample}.db (built by that lab's
// build-corpus.ts) and writes out/birdbrain-graph{,-sample}.db with:
//   - chunks and chunks_fts dropped: raw Chaos Session transcript, people's own words
//   - concepts.first_speaker dropped: who said what is not for sale
// What stays is the graph already published to Fangorn and anchored on Asset Hub
// (vertices, edges, their FTS) plus the extracted concepts without a speaker.
//
//   bun run adapters/birdbrain-graph.ts

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = process.env.BB402_OUT || join(import.meta.dir, "../birdbrain-402/out");
const OUT = join(import.meta.dir, "../out");
mkdirSync(OUT, { recursive: true });

for (const [from, to] of [
  ["birdbrain.db", "birdbrain-graph.db"],
  ["sample.db", "birdbrain-graph-sample.db"],
]) {
  const src = join(SRC, from);
  const dst = join(OUT, to);
  if (!existsSync(src)) throw new Error(`missing ${src}: run lab/birdbrain-402/scripts/build-corpus.ts`);
  for (const s of ["", "-wal", "-shm"]) rmSync(dst + s, { force: true });
  copyFileSync(src, dst);
  const db = new Database(dst);
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("DROP TABLE IF EXISTS chunks_fts");
  db.exec("DROP TABLE IF EXISTS chunks");
  db.exec("ALTER TABLE concepts DROP COLUMN first_speaker");
  db.exec("VACUUM");
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r: any) => r.name);
  const counts = Object.fromEntries(
    tables.map((t: string) => [t, (db.query(`SELECT count(*) n FROM ${t}`).get() as any).n]),
  );
  db.close();
  console.log(dst, counts);
}
