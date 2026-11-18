// birdbrain-402 — pay-per-query over the Birdbrain corpus, settled in dUSD
// on Kusama Asset Hub mainnet.
//
// Settle-first, per the select402 teardown (https://select402.com):
// keep HTTP 402, drop every other part of x402. No EIP-3009, no secp256k1, no
// ERC-20 precompile, no ETH RPC. You transfer dUSD, then present the block as
// proof. The signature is not the payment authorisation — it binds an
// already-settled transfer to this payer and this query.
//
// The one thing we do NOT copy from select402: its meter (base + rows scanned +
// rows returned). Scanning is not our cost. We meter delivery only, and we
// quote exactly rather than estimating — the count runs on the full corpus for
// free, only the rows are paid for.
//
// The other thing we do not copy: its replay defence. A signature over the
// query stops a *different* payer replaying your block; it does not stop the
// *same* payer claiming one settled transfer against two queries. We key the
// spent set on the transfer itself (block + extrinsic index), so one payment
// can be claimed exactly once.

import { Database } from "bun:sqlite";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { signatureVerify, cryptoWaitReady, decodeAddress } from "@polkadot/util-crypto";
import { createHash } from "node:crypto";
import { join } from "node:path";

const PORT = Number(process.env.PORT || "3702");
const DUSD_ASSET = 50000002;
const DUSD_DECIMALS = 6;
const RECIPIENT = "FvrbaMus8iASyrQYkajQWDxsYvG5gb72PFPuvy8TvkFFVGn";
const RPC = process.env.AH_RPC || "wss://kusama-asset-hub-rpc.polkadot.io";

// Meter, in dUSD base units (6 dp).
const BASE_FEE = 10_000n;     // 0.01 dUSD to ask anything
const PER_ROW = 1_000n;       // 0.001 dUSD per row delivered
const MAX_ROWS = 500;

const DB_FULL = join(import.meta.dir, "out/birdbrain.db");
const DB_SAMPLE = join(import.meta.dir, "out/sample.db");

const full = new Database(DB_FULL, { readonly: true });
const sample = new Database(DB_SAMPLE, { readonly: true });

// Spent-transfer set. One settled transfer, one claim. In-process for the
// experiment; the generalised port (lab/query-meter) persists it to SQLite,
// which is the only thing that changed rather than moved.
const spent = new Set<string>();

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

function run(db: Database, sql: string, limit: number) {
  return db.query(`SELECT * FROM (${sql}) LIMIT ${limit}`).all();
}

function countRows(db: Database, sql: string): number {
  const r = db.query(`SELECT count(*) AS n FROM (${sql})`).get() as { n: number };
  return Math.min(r.n, MAX_ROWS);
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
    breakdown: {
      base: dusd(BASE_FEE),
      per_row: dusd(PER_ROW),
      rows,
    },
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
 * Settle-first verification, in four steps. Each one can reject.
 *
 *  1. the signature binds this payer to this exact query
 *  2. the block is canonical and finalised
 *  3. it contains a successful dUSD transfer, payer → us, of at least the quote
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

  // 1 — signature over sha256(sql), by the claimed payer.
  let ok: boolean;
  try {
    ok = signatureVerify(sha256(sql), proof.sig, proof.from).isValid;
  } catch (e: any) {
    return { ok: false as const, reason: `signature could not be checked: ${e.message}` };
  }
  if (!ok) return { ok: false as const, reason: "signature does not bind this payer to this query" };

  // 2 — block must be canonical and final. Anything else is not yet money.
  let header;
  try {
    header = await api.rpc.chain.getHeader(proof.block);
  } catch {
    return { ok: false as const, reason: "block hash not found on this chain" };
  }
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalizedNum = (await api.rpc.chain.getHeader(finalizedHash)).number.toNumber();
  if (header.number.toNumber() > finalizedNum) {
    return { ok: false as const, reason: `block ${header.number} is not yet finalised (final: ${finalizedNum})` };
  }
  const canonical = await api.rpc.chain.getBlockHash(header.number.toNumber());
  if (canonical.toHex() !== proof.block.toLowerCase()) {
    return { ok: false as const, reason: "block is not on the canonical chain" };
  }

  // 3 — find a successful dUSD transfer, payer → recipient, in that block.
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
    // Only count it if the extrinsic itself succeeded.
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
    return { ok: false as const, reason: `no successful dUSD transfer from ${proof.from} to ${RECIPIENT} in that block` };
  }
  if (paid < owed) {
    return { ok: false as const, reason: `underpaid: found ${dusd(paid)} dUSD, quote is ${dusd(owed)} dUSD` };
  }

  // 4 — one settled transfer, one claim. This is the hole in select402's design:
  // its signature stops a different payer replaying your block, but nothing
  // stops you claiming your own single payment against a second query.
  const receipt = `${proof.block}:${index}`;
  if (spent.has(receipt)) {
    return { ok: false as const, reason: `payment ${receipt} has already been claimed` };
  }
  spent.add(receipt);

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

const stat = (db: Database, t: string) => (db.query(`SELECT count(*) n FROM ${t}`).get() as any).n;

const CATALOGUE = {
  name: "birdbrain/world",
  description:
    "Decent's world model as SQL: the Birdbrain knowledge graph (as published to Fangorn) plus the Chaos Sessions corpus it was derived from.",
  version: "0.1.0",
  network: "kusama-asset-hub",
  token: { symbol: "dUSD", asset_id: DUSD_ASSET, decimals: DUSD_DECIMALS },
  recipient: RECIPIENT,
  pricing: {
    model: "base + per row delivered",
    base: dusd(BASE_FEE),
    per_row_returned: dusd(PER_ROW),
    max_rows: MAX_ROWS,
    note: "Rows scanned are not metered. Scanning is not the cost here; delivery is. Quotes are exact, not estimated — the count runs on the full corpus for free.",
  },
  tables: {
    vertices: "world-model nodes — session · person · concept · topic · question · decision",
    edges: "attended · has-topic · surfaces · raises · raised",
    chunks: "Chaos Session transcript chunks",
    concepts: "extracted concepts with speaker + timestamp",
    chunks_fts: "FTS5 over transcript text",
    vertices_fts: "FTS5 over node labels + summaries",
  },
  flow: [
    "GET  /                     — this catalogue",
    "GET  /manifest.json        — schema + row counts",
    "GET  /sample.db            — free sample (CS01–CS03), develop your query locally",
    "POST /query {sql}          — free run against the sample + an exact quote for the full corpus",
    "POST /query + X-Payment    — transfer the quoted dUSD, then present block=…; from=…; sig=…",
  ],
};

const json = (b: any, status = 200) =>
  Response.json(b, { status, headers: { "access-control-allow-origin": "*" } });

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/catalogue") {
      return json(CATALOGUE);
    }

    if (url.pathname === "/manifest.json") {
      const schema = full
        .query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")
        .all();
      return json({
        ...CATALOGUE,
        schema,
        rows: {
          full: { vertices: stat(full, "vertices"), edges: stat(full, "edges"), chunks: stat(full, "chunks"), concepts: stat(full, "concepts") },
          sample: { vertices: stat(sample, "vertices"), edges: stat(sample, "edges"), chunks: stat(sample, "chunks"), concepts: stat(sample, "concepts") },
        },
      });
    }

    if (url.pathname === "/sample.db") {
      return new Response(Bun.file(DB_SAMPLE), {
        headers: { "content-type": "application/vnd.sqlite3", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/health") {
      return json({ status: "ok", chain: (api as any)._runtimeChain?.toString(), spent_claims: spent.size });
    }

    if (url.pathname === "/query" && req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "body must be JSON: {\"sql\": \"SELECT …\"}" }, 400);
      }
      const sql: string = (body.sql ?? "").trim().replace(/;$/, "");
      if (!sql) return json({ error: "sql is required" }, 400);

      const bad = guard(sql);
      if (bad) return json({ error: "rejected", reason: bad }, 400);

      let rows: number;
      try {
        rows = countRows(full, sql);
      } catch (e: any) {
        return json({ error: "sql failed against the corpus", reason: e.message }, 400);
      }
      const q = quote(rows);
      const owed = BigInt(q.amount);

      const header = req.headers.get("x-payment");
      if (!header) {
        // Free tier: your query, run for real, but only against the sample.
        let sampleRows: any[] = [];
        let sampleNote: string | undefined;
        try {
          sampleRows = run(sample, sql, MAX_ROWS);
        } catch (e: any) {
          sampleNote = `query did not run against the sample: ${e.message}`;
        }
        return json(
          {
            paid: false,
            quote: q,
            query_hash: hex(sha256(sql)),
            payment: {
              network: "kusama-asset-hub",
              asset: DUSD_ASSET,
              recipient: RECIPIENT,
              amount: q.amount,
              amount_dusd: q.amount_dusd,
              instructions:
                `Transfer >= ${q.amount_dusd} dUSD (asset ${DUSD_ASSET}) to ${RECIPIENT}, wait for finality, then retry with header: ` +
                `X-Payment: block=0x<block_hash>; from=<your_ss58>; sig=0x<signature>`,
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
      if (!v.ok) return json({ paid: false, error: "payment_rejected", reason: v.reason, quote: q }, 402);

      const results = run(full, sql, MAX_ROWS);
      return json({
        paid: true,
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

console.log(`birdbrain-402 live on :${PORT} — dUSD asset ${DUSD_ASSET} → ${RECIPIENT}`);
