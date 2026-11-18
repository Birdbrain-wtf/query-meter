// Build the Birdbrain corpus as queryable SQLite.
//
// Sources:
//   lab/birdbrain-fangorn/out/metagraph.json          — the world-model graph (vertices + edges)
//   core/vault/calls/chaos-sessions/_semantic/*.jsonl — session chunks + extracted concepts
//
// Emits out/birdbrain.db (full, paid) and out/sample.db (free — three sessions).

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.WORKSPACE || "/home/workspace";
const META = join(ROOT, "lab/birdbrain-fangorn/out/metagraph.json");
const SEM = join(ROOT, "core/vault/calls/chaos-sessions/_semantic");
const OUT = join(import.meta.dir, "../out");

const SAMPLE_SESSIONS = new Set(["CS01", "CS02", "CS03"]);

const SCHEMA = `
CREATE TABLE vertices (
  key        TEXT PRIMARY KEY,
  schema     TEXT NOT NULL,
  type       TEXT NOT NULL,
  label      TEXT,
  date       TEXT,
  day_count  INTEGER,
  summary    TEXT,
  url        TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX idx_vertices_type ON vertices(type);
CREATE INDEX idx_vertices_date ON vertices(date);

CREATE TABLE edges (
  label     TEXT NOT NULL,
  from_key  TEXT NOT NULL,
  to_key    TEXT NOT NULL
);
CREATE INDEX idx_edges_from ON edges(from_key);
CREATE INDEX idx_edges_to   ON edges(to_key);
CREATE INDEX idx_edges_label ON edges(label);

CREATE TABLE chunks (
  id       TEXT PRIMARY KEY,
  session  TEXT NOT NULL,
  date     TEXT,
  text     TEXT NOT NULL
);
CREATE INDEX idx_chunks_session ON chunks(session);

CREATE TABLE concepts (
  id             TEXT PRIMARY KEY,
  session        TEXT NOT NULL,
  date           TEXT,
  name           TEXT,
  summary        TEXT,
  first_speaker  TEXT,
  timestamp      TEXT
);
CREATE INDEX idx_concepts_session ON concepts(session);
CREATE INDEX idx_concepts_name ON concepts(name);

CREATE VIRTUAL TABLE chunks_fts   USING fts5(id UNINDEXED, session UNINDEXED, text);
CREATE VIRTUAL TABLE vertices_fts USING fts5(key UNINDEXED, type UNINDEXED, label, summary);
`;

function jsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function build(dbPath: string, opts: { sampleOnly: boolean }) {
  if (existsSync(dbPath)) require("node:fs").unlinkSync(dbPath);
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const meta = JSON.parse(readFileSync(META, "utf8"));

  // Which vertices belong in a sample? Everything tied to the sample sessions,
  // plus the sample sessions themselves — so a free query returns a coherent
  // sub-graph rather than three orphan nodes.
  const keep = new Set<string>();
  if (opts.sampleOnly) {
    for (const s of SAMPLE_SESSIONS) keep.add(`session_${s}`);
    for (const e of meta.edges) {
      if (keep.has(e.from)) keep.add(e.to);
      if (keep.has(e.to)) keep.add(e.from);
    }
  }

  const insV = db.prepare(
    "INSERT OR IGNORE INTO vertices (key, schema, type, label, date, day_count, summary, url, data) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insVF = db.prepare("INSERT INTO vertices_fts (key, type, label, summary) VALUES (?,?,?,?)");
  let nv = 0;
  db.transaction(() => {
    for (const v of meta.vertices) {
      if (opts.sampleOnly && !keep.has(v.key)) continue;
      const type = v.schema.split(".")[1];
      const d = v.data ?? {};
      insV.run(
        v.key,
        v.schema,
        type,
        d.label ?? null,
        d.date ?? null,
        d.day_count ?? null,
        d.summary ?? d.frame ?? null,
        d.url ?? null,
        JSON.stringify(d),
      );
      insVF.run(v.key, type, d.label ?? "", d.summary ?? d.frame ?? "");
      nv++;
    }
  })();

  const insE = db.prepare("INSERT INTO edges (label, from_key, to_key) VALUES (?,?,?)");
  let ne = 0;
  db.transaction(() => {
    for (const e of meta.edges) {
      if (opts.sampleOnly && !(keep.has(e.from) && keep.has(e.to))) continue;
      insE.run(e.label, e.from, e.to);
      ne++;
    }
  })();

  const insC = db.prepare("INSERT OR IGNORE INTO chunks (id, session, date, text) VALUES (?,?,?,?)");
  const insCF = db.prepare("INSERT INTO chunks_fts (id, session, text) VALUES (?,?,?)");
  let nc = 0;
  db.transaction(() => {
    for (const c of jsonl(join(SEM, "chunks.jsonl"))) {
      if (opts.sampleOnly && !SAMPLE_SESSIONS.has(c.session)) continue;
      insC.run(c.id, c.session, c.date ?? null, c.text);
      insCF.run(c.id, c.session, c.text);
      nc++;
    }
  })();

  const insK = db.prepare(
    "INSERT OR IGNORE INTO concepts (id, session, date, name, summary, first_speaker, timestamp) VALUES (?,?,?,?,?,?,?)",
  );
  let nk = 0;
  db.transaction(() => {
    for (const k of jsonl(join(SEM, "concepts.jsonl"))) {
      if (opts.sampleOnly && !SAMPLE_SESSIONS.has(k.session)) continue;
      // The embedding vector is deliberately dropped — it is 80% of the file
      // and nothing in a SELECT can use it.
      insK.run(k.id, k.session, k.date ?? null, k.name ?? null, k.summary ?? null, k.first_speaker ?? null, k.timestamp ?? null);
      nk++;
    }
  })();

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return { nv, ne, nc, nk };
}

mkdirSync(OUT, { recursive: true });
const full = build(join(OUT, "birdbrain.db"), { sampleOnly: false });
const sample = build(join(OUT, "sample.db"), { sampleOnly: true });

console.log("full  ", full);
console.log("sample", sample);
console.log("wrote ", join(OUT, "birdbrain.db"), "and", join(OUT, "sample.db"));
