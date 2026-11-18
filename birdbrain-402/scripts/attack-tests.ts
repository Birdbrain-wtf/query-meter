// Adversarial checks against a receipt that has already been used once.
//
// The interesting one is #1. It is the flaw we read in select402's design and
// the reason this server keeps a spent-transfer set: the signature stops a
// *different* payer replaying your block, but the payer owns the key, so
// nothing in the signature alone stops them signing a *second* query and
// presenting the *same* settled transfer against it.
//
//   bun run scripts/attack-tests.ts <block_hash>

import { createHash } from "node:crypto";
import { buyer, seller, ss58 } from "./keys.ts";

const ENDPOINT = process.env.BB402 || "http://localhost:3702";
const block = process.argv[2];
if (!block) {
  console.error("usage: bun run scripts/attack-tests.ts <block_hash_of_a_settled_payment>");
  process.exit(1);
}

const PAID_SQL =
  "SELECT v.label AS person, count(*) AS sessions FROM edges e JOIN vertices v ON v.key=e.from_key WHERE e.label='attended' GROUP BY v.label ORDER BY sessions DESC LIMIT 5";
const OTHER_SQL = "SELECT label, summary FROM vertices WHERE type='concept' LIMIT 5";

const pair = await buyer();
const other = await seller();
const sign = (p: any, sql: string) => "0x" + Buffer.from(p.sign(createHash("sha256").update(sql, "utf8").digest())).toString("hex");

async function attempt(name: string, sql: string, header: string, expect: "allow" | "deny", reasonHas?: string) {
  const r = await fetch(`${ENDPOINT}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": header },
    body: JSON.stringify({ sql }),
  });
  const b: any = await r.json();
  const denied = r.status !== 200;
  const ok = (expect === "deny" ? denied : !denied) && (!reasonHas || String(b.reason ?? "").includes(reasonHas));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      → ${r.status} ${b.reason ?? (b.paid ? `served ${b.rows} rows` : JSON.stringify(b).slice(0, 120))}`);
  return ok;
}

const results = [
  // 1. Same settled transfer, a second query, correctly signed by its real payer.
  //    This is the select402 hole. Only the spent set refuses it.
  await attempt(
    "double-claim: reuse one payment for a second query",
    OTHER_SQL,
    `block=${block}; from=${ss58(pair)}; sig=${sign(pair, OTHER_SQL)}`,
    "deny",
  ),

  // 2. Straight replay of the original claim.
  await attempt(
    "replay: same payment, same query, twice",
    PAID_SQL,
    `block=${block}; from=${ss58(pair)}; sig=${sign(pair, PAID_SQL)}`,
    "deny",
  ),

  // 3. Someone else's block. The signature is valid, but they never paid.
  await attempt(
    "theft: a third party presents the payer's block",
    PAID_SQL,
    `block=${block}; from=${ss58(other)}; sig=${sign(other, PAID_SQL)}`,
    "deny",
  ),

  // 4. Signature over a different query than the one submitted.
  await attempt(
    "swap: signature does not cover the submitted query",
    OTHER_SQL,
    `block=${block}; from=${ss58(pair)}; sig=${sign(pair, PAID_SQL)}`,
    "deny",
  ),

  // 5. A block that exists but contains no payment from this payer.
  await attempt(
    "wrong block: finalised, canonical, no transfer in it",
    PAID_SQL,
    `block=0x0000000000000000000000000000000000000000000000000000000000000000; from=${ss58(pair)}; sig=${sign(pair, PAID_SQL)}`,
    "deny",
  ),

  // 6. Writes must never reach the corpus, paid or not.
  await attempt(
    "sql guard: DROP TABLE is refused before payment is even considered",
    "SELECT 1; DROP TABLE vertices",
    `block=${block}; from=${ss58(pair)}; sig=${sign(pair, "SELECT 1; DROP TABLE vertices")}`,
    "deny",
  ),

  // 7. Paying yourself emits a Transferred event but moves nothing. RECIPIENT is
  //    public, so no key is needed to try it: the refusal must name the reason.
  await attempt(
    "self-payment: the claimed payer is the recipient",
    PAID_SQL,
    `block=${block}; from=FvrbaMus8iASyrQYkajQWDxsYvG5gb72PFPuvy8TvkFFVGn; sig=0x${"00".repeat(64)}`,
    "deny",
    "self-transfer",
  ),
];

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
