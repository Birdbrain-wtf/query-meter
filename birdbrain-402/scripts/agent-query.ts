// The buyer's side of the loop — what a paying agent actually does.
//
//   bun run scripts/agent-query.ts "SELECT …"
//
//   1. ask for free  → the server runs it on the sample and quotes the full run
//   2. sign          → sr25519 over sha256(sql), binding this payer to this query
//   3. settle        → transfer the quoted dUSD on Kusama Asset Hub, wait for finality
//   4. claim         → present block + payer + signature, receive the rows
//
// Fees are paid in dUSD, so the agent needs no KSM at all.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { createHash } from "node:crypto";
import { buyer, ss58 } from "./keys.ts";

const ENDPOINT = process.env.BB402 || "http://localhost:3702";
const DUSD = 50000002;
const DUSD_LOCATION = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: DUSD }] } };

const sql = (process.argv[2] ?? "").trim();
if (!sql) {
  console.error('usage: bun run scripts/agent-query.ts "SELECT …"');
  process.exit(1);
}

const ask = (headers: Record<string, string> = {}) =>
  fetch(`${ENDPOINT}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ sql }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

// 1 — free run + exact quote
console.log("→ asking for a quote …");
const free = await ask();
if (free.status !== 402) {
  console.log(JSON.stringify(free.body, null, 2));
  process.exit(free.status === 200 ? 0 : 1);
}
const { quote, payment, sample } = free.body as any;
console.log(`  quote: ${quote.amount_dusd} dUSD for ${quote.rows} rows (base ${quote.breakdown.base} + ${quote.rows}×${quote.breakdown.per_row})`);
console.log(`  free sample run returned ${sample.rows} rows${sample.note ? ` — ${sample.note}` : ""}`);

// 2 — bind payer to query
const pair = await buyer();
const digest = createHash("sha256").update(sql, "utf8").digest();
const sig = "0x" + Buffer.from(pair.sign(digest)).toString("hex");
console.log(`\n→ signing sha256(sql) as ${ss58(pair)}`);

// 3 — settle first
const api = await ApiPromise.create({ provider: new WsProvider("wss://kusama-asset-hub-rpc.polkadot.io"), noInitWarn: true });
console.log(`→ transferring ${quote.amount_dusd} dUSD to ${payment.recipient} …`);

const block = await new Promise<string>((resolve, reject) => {
  api.tx.assets
    .transfer(DUSD, payment.recipient, BigInt(quote.amount))
    .signAndSend(pair, { assetId: DUSD_LOCATION }, ({ status, dispatchError }) => {
      if (dispatchError) {
        const msg = dispatchError.isModule
          ? (() => {
              const d = api.registry.findMetaError(dispatchError.asModule);
              return `${d.section}.${d.name}: ${d.docs.join(" ")}`;
            })()
          : dispatchError.toString();
        return reject(new Error(msg));
      }
      if (status.isInBlock) console.log(`  in block ${status.asInBlock.toHex()}`);
      if (status.isFinalized) resolve(status.asFinalized.toHex());
    })
    .catch(reject);
});
console.log(`  finalised ${block}`);

// 4 — claim
console.log("\n→ claiming with X-Payment …");
const paidRes = await ask({ "x-payment": `block=${block}; from=${ss58(pair)}; sig=${sig}` });
console.log(JSON.stringify(paidRes.body, null, 2));
process.exit(paidRes.status === 200 ? 0 : 1);
