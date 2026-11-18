// query-meter — pay-per-query over ANY collective's corpus, settled in dUSD on
// Kusama Asset Hub mainnet.
//
// This is birdbrain-402 with the collective lifted out into configuration. The
// settle-first design is unchanged and is documented in lab/birdbrain-402:
// keep HTTP 402, drop every other part of x402, meter delivery rather than
// scanning, quote exactly rather than estimating, and key the replay defence on
// the transfer itself rather than on the signature.
//
// Four things were collective-specific in the original and are now config:
// the recipient account, the two database paths, the catalogue prose, and the
// table list the manifest counts. Nothing else had to move, which is the useful
// finding: the meter was already general and only looked otherwise.
//
// One thing changed rather than moved. The spent-transfer set is now persisted
// to SQLite instead of living in a Set. It is the integrity boundary — an
// in-process set means a restart makes every prior payment claimable again —
// and the original called that out as the first thing a real deployment fixes.
//
//   bun run engine/server.ts --collective birdbrain
//   COLLECTIVE=birdbrain bun run engine/server.ts

import { Database } from "bun:sqlite";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { signatureVerify, cryptoWaitReady, decodeAddress } from "@polkadot/util-crypto";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..");

// ------------------------------------------------------------------- config

export interface CollectiveConfig {
  slug: string;
  name: string;
  description: string;
  /** Where the money lands. Per ADR 0034 this is the COLLECTIVE's own operator
   *  account, never Decent's. */
  recipient: string;
  recipient_note?: string;
  db: { full: string; sample: string };
  sample: string;
  tables: Record<string, string>;
  /** Which tables the manifest reports row counts for. */
  count_tables: string[];
  pricing?: { base?: number; per_row?: number; max_rows?: number };
  /** No buyer key needed: anyone may ask, payment is the only gate. Opening a
   *  meter is the collective's call (ADR 0034), so this is off unless set. */
  open?: boolean;
  /** Where a buyer asks questions about the meter. */
  contact?: string;
  /** The public URL a buyer reaches this meter at. */
  door?: string;
  /** The demand ledger. Each statement returns one column of node identifiers
   *  from the full corpus. After a paid query, every returned value that is one
   *  of those identifiers is recorded against that node. This is a record of
   *  what outsiders paid to read, kept apart from the contribution record:
   *  paying to read is not contributing (ADR 0034 §5). Off unless set. */
  demand?: { keys: string[] };
}

function pickSlug(): string {
  const i = process.argv.indexOf("--collective");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.COLLECTIVE || "birdbrain";
}

const SLUG = pickSlug();
const CONFIG_PATH = join(ROOT, "collectives", `${SLUG}.json`);
if (!existsSync(CONFIG_PATH)) {
  console.error(`no config for collective "${SLUG}" — expected ${CONFIG_PATH}`);
  process.exit(1);
}
const cfg: CollectiveConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const resolve = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));
const DB_FULL = resolve(cfg.db.full);
const DB_SAMPLE = resolve(cfg.db.sample);
for (const p of [DB_FULL, DB_SAMPLE]) {
  if (!existsSync(p)) {
    console.error(`corpus missing: ${p} — build it first (see AGENTS.md)`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || "3703");
const DUSD_ASSET = 50000002;
const DUSD_DECIMALS = 6;
const RECIPIENT = cfg.recipient;
const RPC = process.env.AH_RPC || "wss://kusama-asset-hub-rpc.polkadot.io";

const BASE_FEE = BigInt(cfg.pricing?.base ?? 10_000); // 0.01 dUSD to ask anything
const PER_ROW = BigInt(cfg.pricing?.per_row ?? 1_000); // 0.001 dUSD per row delivered
const MAX_ROWS = cfg.pricing?.max_rows ?? 500;

const full = new Database(DB_FULL, { readonly: true });
const sample = new Database(DB_SAMPLE, { readonly: true });
const CONTACT = cfg.contact || "hello@decent.partners";

// ------------------------------------------------------------ demand ledger
//
// Which parts of the world model paid queries returned. It names nodes, never
// the buyer (the payer stays in the request log, joined by claim_id), and it
// pays nobody: what members do with it is theirs to decide (ADR 0034 §2-3).

const DEMAND_KEYS = new Set<string>();
for (const q of cfg.demand?.keys ?? []) {
  for (const r of full.query(q).values()) if (r[0] != null) DEMAND_KEYS.add(String(r[0]));
}

function demandOf(rows: any[]): { nodes: Record<string, number>; matched_rows: number } {
  const nodes: Record<string, number> = {};
  let matched_rows = 0;
  for (const row of rows) {
    const seen = new Set<string>();
    for (const v of Object.values(row ?? {})) {
      if (typeof v === "string" && DEMAND_KEYS.has(v)) seen.add(v);
    }
    if (seen.size) matched_rows++;
    for (const k of seen) nodes[k] = (nodes[k] ?? 0) + 1;
  }
  return { nodes, matched_rows };
}

// Buyer SQL runs in a child process with a deadline (engine/sql-runner.ts), at
// most SQL_SLOTS at once, so one expensive query cannot hold the meter.
const SQL_TIMEOUT_MS = Number(process.env.QM_SQL_TIMEOUT_MS || "5000");
const SQL_SLOTS = Number(process.env.QM_SQL_SLOTS || "3");
const RUNNER = join(HERE, "sql-runner.ts");
let busy = 0;

async function sqlIn(dbPath: string, sql: string, mode: "count" | "rows", limit = 0): Promise<any> {
  if (busy >= SQL_SLOTS) throw new Error("the meter is busy, try again in a moment");
  busy++;
  try {
    const p = Bun.spawn([process.execPath, RUNNER], {
      stdin: new Blob([JSON.stringify({ db: dbPath, sql, mode, limit })]),
      stdout: "pipe",
      stderr: "ignore",
      timeout: SQL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    if (p.signalCode) throw new Error(`query took longer than ${SQL_TIMEOUT_MS / 1000}s and was stopped`);
    const r = JSON.parse(out || "{}");
    if (r.error) throw new Error(r.error);
    return r;
  } finally {
    busy--;
  }
}

// ------------------------------------------------------- spent-transfer set
//
// One settled transfer, one claim, across restarts. Keyed on the transfer
// (block hash : extrinsic index), not on the signature — a signature over the
// query stops a different payer replaying your block, and does nothing about
// you claiming your own payment twice.

const STATE_DIR = process.env.QM_STATE || join(ROOT, "state");
mkdirSync(STATE_DIR, { recursive: true });
const ledger = new Database(join(STATE_DIR, `${SLUG}-claims.db`), { create: true });
ledger.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    receipt    TEXT PRIMARY KEY,
    collective TEXT NOT NULL,
    payer      TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    paid       TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  )
`);
// ------------------------------------------------------------- buyer keys
//
// A corpus is a collective's own material, and ADR 0034 makes opening the meter
// a members' governance act rather than an engineering one. So a meter can be
// reachable from outside without being open: a named key per buyer, scoped to
// the collectives that buyer may ask about, issued by hand and revoked by
// deleting a line. Fails closed — no keys file, nobody in.
//
// The key is a guest list. Payment is still the price of an answer.

const KEYS_FILE = process.env.QM_KEYS || join(ROOT, "buyers.json");

interface Buyer {
  label: string;
  collectives?: string[];
  issued?: string;
  note?: string;
}

let keysCache: { mtime: number; keys: Record<string, Buyer> } = { mtime: 0, keys: {} };

function buyers(): Record<string, Buyer> {
  try {
    const m = statSync(KEYS_FILE).mtimeMs;
    if (m !== keysCache.mtime) {
      keysCache = { mtime: m, keys: JSON.parse(readFileSync(KEYS_FILE, "utf8")) };
      console.log(`buyer keys reloaded: ${Object.values(keysCache.keys).map((b) => b.label).join(", ") || "none"}`);
    }
  } catch {
    keysCache = { mtime: 0, keys: {} };
  }
  return keysCache.keys;
}

/** The buyer this request is, or null. Scope is per collective, so a key for
 *  one corpus is not a key for a client's. */
function whois(req: Request, url: URL): Buyer | null {
  const presented = req.headers.get("x-buyer-key") || url.searchParams.get("key") || "";
  const b = presented ? buyers()[presented] : undefined;
  const scoped = b && (!b.collectives || b.collectives.includes(SLUG)) ? b : null;
  // An open meter still labels a known key in the record, and lets anyone else in.
  if (cfg.open) return scoped ?? { label: "public" };
  return scoped;
}

/** Every quote, rejection and purchase, appended. This is the record — without
 *  it a sale is an anecdote. */
function logRequest(row: Record<string, unknown>) {
  try {
    appendFileSync(
      join(STATE_DIR, `${SLUG}-requests.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), collective: SLUG, ...row }) + "\n",
    );
  } catch (e: any) {
    console.error(`could not write the request log: ${e.message}`);
  }
}

const findClaim = ledger.prepare("SELECT receipt FROM claims WHERE receipt = ?");
const addClaim = ledger.prepare(
  "INSERT INTO claims (receipt, collective, payer, query_hash, paid, claimed_at) VALUES (?,?,?,?,?,?)",
);
const countClaims = ledger.prepare("SELECT count(*) n FROM claims");

await cryptoWaitReady();
console.log(`connecting ${RPC} …`);
const api = await ApiPromise.create({ provider: new WsProvider(RPC), noInitWarn: true });
console.log(`connected: ${await api.rpc.system.chain()}`);

// ---------------------------------------------------------------- SQL guard

const FORBIDDEN =
  /\b(attach|detach|pragma|insert|update|delete|drop|alter|create|replace|vacuum|reindex|load_extension)\b/i;

function guard(sql: string): string | null {
  const s = sql.trim().replace(/;$/, "");
  if (!/^select\b/i.test(s) && !/^with\b/i.test(s)) return "only SELECT (or WITH … SELECT) is allowed";
  if (s.includes(";")) return "one statement per request";
  if (FORBIDDEN.test(s)) return "statement contains a forbidden keyword";
  return null;
}

const run = async (dbPath: string, sql: string, limit: number): Promise<any[]> =>
  (await sqlIn(dbPath, sql, "rows", limit)).rows;

async function countRows(dbPath: string, sql: string): Promise<number> {
  const r = await sqlIn(dbPath, sql, "count");
  return Math.min(Number(r.n), MAX_ROWS);
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
const hex = (b: Buffer | Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const dusd = (n: bigint) => Number(n) / 10 ** DUSD_DECIMALS;

function quote(rows: number) {
  const amount = BASE_FEE + PER_ROW * BigInt(rows);
  return {
    rows,
    amount: amount.toString(),
    amount_dusd: dusd(amount),
    breakdown: { base: dusd(BASE_FEE), per_row: dusd(PER_ROW), rows },
  };
}

// ------------------------------------------------------------- verification

interface Proof {
  block: string;
  from: string;
  sig: string;
}

function parsePayment(header: string): Proof | { error: string } {
  const parts: Record<string, string> = {};
  for (const p of header.split(";").map((s) => s.trim())) {
    const [k, ...rest] = p.split("=");
    if (k && rest.length) parts[k.toLowerCase().trim()] = rest.join("=").trim();
  }
  if (!parts.block || !parts.from || !parts.sig) {
    return { error: "X-Payment must be: block=0x…; from=<ss58>; sig=0x…" };
  }
  return { block: parts.block, from: parts.from, sig: parts.sig };
}

/**
 * Settle-first verification, in four steps, each of which can reject:
 *  1. the signature binds this payer to this exact query
 *  2. the block is canonical and finalised
 *  3. it carries a successful dUSD transfer, payer → us, of at least the quote
 *  4. that specific transfer has not been claimed before
 */
async function verify(proof: Proof, sql: string, owed: bigint) {
  // A self-transfer moves no money but still emits assets.Transferred, so the
  // event alone would read as a payment. Refuse it whatever ss58 form it uses.
  let selfPayment = false;
  try {
    selfPayment = hex(decodeAddress(proof.from)) === hex(decodeAddress(RECIPIENT));
  } catch {}
  if (selfPayment) {
    return { ok: false as const, reason: "self-transfer: the payer is the recipient, so no money moved" };
  }

  let ok: boolean;
  try {
    ok = signatureVerify(sha256(sql), proof.sig, proof.from).isValid;
  } catch (e: any) {
    return { ok: false as const, reason: `signature could not be checked: ${e.message}` };
  }
  if (!ok) return { ok: false as const, reason: "signature does not bind this payer to this query" };

  let header;
  try {
    header = await api.rpc.chain.getHeader(proof.block);
  } catch {
    return { ok: false as const, reason: "block hash not found on this chain" };
  }
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalizedNum = (await api.rpc.chain.getHeader(finalizedHash)).number.toNumber();
  if (header.number.toNumber() > finalizedNum) {
    return {
      ok: false as const,
      reason: `block ${header.number} is not yet finalised (final: ${finalizedNum})`,
    };
  }
  const canonical = await api.rpc.chain.getBlockHash(header.number.toNumber());
  if (canonical.toHex() !== proof.block.toLowerCase()) {
    return { ok: false as const, reason: "block is not on the canonical chain" };
  }

  const [block, events] = await Promise.all([
    api.rpc.chain.getBlock(proof.block),
    api.query.system.events.at(proof.block),
  ]);
  const payerPub = hex(decodeAddress(proof.from));
  const recipPub = hex(decodeAddress(RECIPIENT));

  let paid = 0n;
  let index = -1;
  (events as any).forEach((rec: any) => {
    const { event, phase } = rec;
    if (!phase.isApplyExtrinsic) return;
    if (event.section !== "assets" || event.method !== "Transferred") return;
    const [assetId, from, to, amount] = event.data;
    if (Number(assetId.toString()) !== DUSD_ASSET) return;
    if (hex(decodeAddress(from.toString())) !== payerPub) return;
    if (hex(decodeAddress(to.toString())) !== recipPub) return;
    const i = phase.asApplyExtrinsic.toNumber();
    const succeeded = (events as any).some(
      (r: any) =>
        r.phase.isApplyExtrinsic &&
        r.phase.asApplyExtrinsic.toNumber() === i &&
        r.event.section === "system" &&
        r.event.method === "ExtrinsicSuccess",
    );
    if (!succeeded) return;
    if (BigInt(amount.toString()) > paid) {
      paid = BigInt(amount.toString());
      index = i;
    }
  });

  if (index < 0) {
    return {
      ok: false as const,
      reason: `no successful dUSD transfer from ${proof.from} to ${RECIPIENT} in that block`,
    };
  }
  if (paid < owed) {
    return { ok: false as const, reason: `underpaid: found ${dusd(paid)} dUSD, quote is ${dusd(owed)} dUSD` };
  }

  const receipt = `${proof.block}:${index}`;
  if (findClaim.get(receipt)) {
    return { ok: false as const, reason: `payment ${receipt} has already been claimed` };
  }
  addClaim.run(receipt, SLUG, proof.from, hex(sha256(sql)), paid.toString(), new Date().toISOString());

  return {
    ok: true as const,
    receipt,
    paid: paid.toString(),
    paid_dusd: dusd(paid),
    block_number: header.number.toNumber(),
    extrinsic_index: index,
    tx: block.block.extrinsics[index].hash.toHex(),
  };
}

// -------------------------------------------------------------------- HTTP

const stat = (db: Database, t: string) => {
  try {
    return (db.query(`SELECT count(*) n FROM ${t}`).get() as any).n;
  } catch {
    return null;
  }
};

const CATALOGUE = {
  collective: cfg.slug,
  name: cfg.name,
  description: cfg.description,
  version: "0.1.0",
  network: "kusama-asset-hub",
  token: { symbol: "dUSD", asset_id: DUSD_ASSET, decimals: DUSD_DECIMALS },
  recipient: RECIPIENT,
  recipient_note: cfg.recipient_note,
  pricing: {
    model: "base + per row delivered",
    base: dusd(BASE_FEE),
    per_row_returned: dusd(PER_ROW),
    max_rows: MAX_ROWS,
    note:
      "Rows scanned are not metered. Scanning is not the cost here; delivery is. " +
      "Quotes are exact, not estimated — the count runs on the full corpus for free.",
  },
  door: cfg.door,
  access: cfg.open
    ? "Open: no key needed. Anyone may ask; payment in dUSD is the only gate."
    : "Private experiment. Every endpoint but /health wants your buyer key, as header X-Buyer-Key or ?key=.",
  limits: `Each query runs for at most ${SQL_TIMEOUT_MS / 1000}s. Results are capped at ${MAX_ROWS} rows.`,
  contact: CONTACT,
  free_tier: cfg.sample,
  record: cfg.demand
    ? "After a paid query, the meter records which graph nodes the rows contained, " +
      "with the amount paid and no buyer identity. Members use it to see what outsiders pay to read. " +
      "Revenue goes to the collective's treasury and is not yet distributed to contributors."
    : undefined,
  tables: cfg.tables,
  flow: [
    "GET  /                     — this catalogue",
    "GET  /manifest.json        — schema + row counts",
    "GET  /sample.db            — free sample, develop your query locally",
    "GET  /buy.ts               — the buyer's script: make a key, swap KSM for dUSD, pay, claim",
    "GET  /README.md            — how to buy, in prose",
    "POST /query {sql}          — free run against the sample + an exact quote for the full corpus",
    "POST /query + X-Payment    — transfer the quoted dUSD, then present block=…; from=…; sig=…",
  ],
};

const json = (b: any, status = 200) =>
  Response.json(b, { status, headers: { "access-control-allow-origin": "*" } });

Bun.serve({
  port: PORT,
  // Loopback only. The way in from outside is the collective's own door (cfg.door),
  // a reverse proxy on its box; nothing should reach this port directly.
  hostname: process.env.QM_HOST || "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({
        status: "ok",
        collective: SLUG,
        chain: (api as any)._runtimeChain?.toString(),
        spent_claims: (countClaims.get() as any).n,
      });
    }

    const who = whois(req, url);
    if (!who) {
      return json(
        {
          error: "no buyer key",
          reason:
            "This meter is a private experiment while the members decide whether to open it (ADR 0034). " +
            `Present your key as header X-Buyer-Key, or ?key=. Ask ${CONTACT} for one.`,
        },
        401,
      );
    }

    // A door that mounts the meter at /query sends POST /query here as POST /, so
    // POST / is the query endpoint too and GET / stays the catalogue.
    const isQuery = req.method === "POST" && (url.pathname === "/query" || url.pathname === "/");

    if (!isQuery && (url.pathname === "/" || url.pathname === "/catalogue"))
      return json({ ...CATALOGUE, you: who.label });

    // The buyer's script, served from the thing it talks to, so the version a
    // buyer runs can never be older than the meter answering them.
    if (url.pathname === "/buy.ts") {
      return new Response(Bun.file(join(ROOT, "kit/buy.ts")), {
        headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/README.md" || url.pathname === "/readme") {
      return new Response(Bun.file(join(ROOT, "kit/README.md")), {
        headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/manifest.json") {
      const schema = full
        .query(
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'",
        )
        .all();
      const counts = (db: Database) =>
        Object.fromEntries(cfg.count_tables.map((t) => [t, stat(db, t)]));
      return json({ ...CATALOGUE, schema, rows: { full: counts(full), sample: counts(sample) } });
    }

    if (url.pathname === "/sample.db") {
      return new Response(Bun.file(DB_SAMPLE), {
        headers: { "content-type": "application/vnd.sqlite3", "access-control-allow-origin": "*" },
      });
    }

    if (isQuery) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'body must be JSON: {"sql": "SELECT …"}' }, 400);
      }
      const sql: string = (body.sql ?? "").trim().replace(/;$/, "");
      if (!sql) return json({ error: "sql is required" }, 400);

      const bad = guard(sql);
      if (bad) return json({ error: "rejected", reason: bad }, 400);

      let rows: number;
      try {
        rows = await countRows(DB_FULL, sql);
      } catch (e: any) {
        return json({ error: "sql failed against the corpus", reason: e.message }, 400);
      }
      const q = quote(rows);
      const owed = BigInt(q.amount);

      const header = req.headers.get("x-payment");
      if (!header) {
        logRequest({ buyer: who.label, event: "quote", sql, rows, quoted_dusd: q.amount_dusd });
        let sampleRows: any[] = [];
        let sampleNote: string | undefined;
        try {
          sampleRows = await run(DB_SAMPLE, sql, MAX_ROWS);
        } catch (e: any) {
          sampleNote = `query did not run against the sample: ${e.message}`;
        }
        return json(
          {
            paid: false,
            collective: SLUG,
            quote: q,
            query_hash: hex(sha256(sql)),
            payment: {
              network: "kusama-asset-hub",
              asset: DUSD_ASSET,
              recipient: RECIPIENT,
              amount: q.amount,
              amount_dusd: q.amount_dusd,
              instructions:
                `Transfer >= ${q.amount_dusd} dUSD (asset ${DUSD_ASSET}) to ${RECIPIENT}, wait for finality, ` +
                `then retry with header: X-Payment: block=0x<block_hash>; from=<your_ss58>; sig=0x<signature>`,
              signature_format: {
                message: "sha256(sql)",
                schemes: ["sr25519", "ed25519"],
                purpose: "Binds an already-settled transfer to this payer and this query.",
              },
            },
            sample: { rows: sampleRows.length, note: sampleNote, results: sampleRows },
          },
          402,
        );
      }

      const proof = parsePayment(header);
      if ("error" in proof) return json({ error: "bad X-Payment", reason: proof.error }, 400);

      const v = await verify(proof, sql, owed);
      if (!v.ok) {
        logRequest({ buyer: who.label, event: "rejected", sql, from: proof.from, reason: v.reason });
        return json({ paid: false, error: "payment_rejected", reason: v.reason, quote: q }, 402);
      }

      let results: any[];
      try {
        results = await run(DB_FULL, sql, MAX_ROWS);
      } catch (e: any) {
        // Paid and claimed but the run failed: record it so the buyer can be made good.
        logRequest({ buyer: who.label, event: "paid_but_failed", sql, from: proof.from, claim_id: v.receipt, reason: e.message });
        return json({ paid: true, error: "query failed after payment", reason: e.message, claim_id: v.receipt, contact: CONTACT }, 500);
      }
      logRequest({
        buyer: who.label,
        event: "paid",
        sql,
        from: proof.from,
        rows: results.length,
        quoted_dusd: q.amount_dusd,
        paid_dusd: v.paid_dusd,
        block: proof.block,
        block_number: v.block_number,
        extrinsic_index: v.extrinsic_index,
        tx: v.tx,
        claim_id: v.receipt,
      });
      if (DEMAND_KEYS.size) {
        try {
          const d = demandOf(results);
          appendFileSync(
            join(STATE_DIR, `${SLUG}-demand.jsonl`),
            JSON.stringify({
              at: new Date().toISOString(),
              collective: SLUG,
              claim_id: v.receipt,
              block_number: v.block_number,
              query_hash: hex(sha256(sql)),
              paid_dusd: v.paid_dusd,
              rows: results.length,
              matched_rows: d.matched_rows,
              nodes: d.nodes,
            }) + "\n",
          );
        } catch (e: any) {
          console.error(`could not write the demand ledger: ${e.message}`);
        }
      }
      return json({
        paid: true,
        collective: SLUG,
        receipt: {
          block: proof.block,
          block_number: v.block_number,
          extrinsic_index: v.extrinsic_index,
          tx: v.tx,
          from: proof.from,
          to: RECIPIENT,
          asset: DUSD_ASSET,
          paid_dusd: v.paid_dusd,
          quoted_dusd: q.amount_dusd,
          claim_id: v.receipt,
        },
        rows: results.length,
        results,
      });
    }

    return json({ error: "not found", see: CATALOGUE.flow }, 404);
  },
});

console.log(
  `query-meter [${SLUG}] live on :${PORT} — dUSD asset ${DUSD_ASSET} → ${RECIPIENT}\n` +
    `  full   ${DB_FULL}\n  sample ${DB_SAMPLE}\n  claims ${join(STATE_DIR, `${SLUG}-claims.db`)}`,
);
