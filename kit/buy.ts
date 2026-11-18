/**
 * buy.ts — the buyer's side of the Birdbrain query meter.
 *
 * You hold KSM on Kusama Asset Hub. This swaps a little of it for dUSD, asks
 * the meter what a query costs, pays, and claims the rows. Nothing here talks
 * to the meter except over HTTP: the key is yours, it is generated on your
 * machine, and the mnemonic never leaves it. The Birdbrain meter is open, so
 * no buyer key is needed. BB402_KEY is only for a meter that still asks for one.
 *
 *   bun add @polkadot/api @polkadot/keyring @polkadot/util-crypto
 *
 *   bun run buy.ts new                                   # make a key
 *   bun run buy.ts status                                # balances
 *   bun run buy.ts swap --dusd=2 --confirm               # KSM -> dUSD
 *   bun run buy.ts ask  "SELECT label FROM vertices LIMIT 5"
 *   bun run buy.ts pay  "SELECT label FROM vertices LIMIT 5" --confirm
 *
 * Nothing moves without --confirm, and every step prints the balances either
 * side of it. `ask` is free and always safe to run.
 */

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate, encodeAddress } from "@polkadot/util-crypto";
import type { KeyringPair } from "@polkadot/keyring/types";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const METER = process.env.BB402_URL || "https://birdbrain.wtf/query";
const BUYER_KEY = process.env.BB402_KEY || "";
const RPC = process.env.AH_RPC || "wss://kusama-asset-hub-rpc.polkadot.io";
const KEYFILE = process.env.BB402_KEYFILE || "./buyer-key.txt";

const DUSD = 50000002;
const DUSD_LOC = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: DUSD }] } };
const KSM_LOC = { parents: 1, interior: "Here" };

const cmd = process.argv[2];
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const flag = (n: string) => process.argv.includes(`--${n}`);
const ss58 = (p: KeyringPair) => encodeAddress(p.publicKey, 2);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function key(): Promise<KeyringPair> {
  await cryptoWaitReady();
  if (!existsSync(KEYFILE)) die(`no key yet at ${KEYFILE} — run: bun run buy.ts new`);
  return new Keyring({ type: "sr25519" }).addFromMnemonic(readFileSync(KEYFILE, "utf8").trim());
}

async function balances(api: ApiPromise, addr: string) {
  const acc: any = await api.query.system.account(addr);
  const asset: any = await api.query.assets.account(DUSD, addr);
  return {
    ksm: Number(acc.data.free.toString()) / 1e12,
    dusd: asset.isSome ? Number(asset.unwrap().balance.toString()) / 1e6 : null,
  };
}

const fmt = (b: { ksm: number; dusd: number | null }) =>
  `${b.ksm.toFixed(6)} KSM  ·  ${b.dusd === null ? "no dUSD account yet" : `${b.dusd.toFixed(6)} dUSD`}`;

/** Sign, send, wait for finality. Resolves to the finalised block hash. */
function send(api: ApiPromise, tx: any, pair: KeyringPair, opts: any = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    tx.signAndSend(pair, opts, ({ status, dispatchError }: any) => {
      if (dispatchError) {
        const msg = dispatchError.isModule
          ? (() => {
              const d = api.registry.findMetaError(dispatchError.asModule);
              return `${d.section}.${d.name}: ${d.docs.join(" ")}`;
            })()
          : dispatchError.toString();
        return reject(new Error(msg));
      }
      if (status.isInBlock) console.log(`   in block ${status.asInBlock.toHex()}`);
      if (status.isFinalized) resolve(status.asFinalized.toHex());
    }).catch(reject);
  });
}

async function meter(path = "", init: RequestInit = {}) {
  const res = await fetch(`${METER}${path}`, {
    ...init,
    headers: {
      ...(BUYER_KEY ? { "x-buyer-key": BUYER_KEY } : {}),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) die("this meter wants a buyer key: set BB402_KEY.");
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ------------------------------------------------------------------- new

if (cmd === "new") {
  await cryptoWaitReady();
  if (existsSync(KEYFILE)) {
    console.log(`already have one: ${ss58(await key())}`);
    process.exit(0);
  }
  const phrase = mnemonicGenerate();
  writeFileSync(KEYFILE, phrase + "\n");
  chmodSync(KEYFILE, 0o600);
  const pair = new Keyring({ type: "sr25519" }).addFromMnemonic(phrase);
  console.log(`your account: ${ss58(pair)}`);
  console.log(`mnemonic in ${KEYFILE} (0600). It is the only copy. Back it up or accept losing it.`);
  console.log(`\nSend KSM here from your exchange. On Kraken the withdrawal method is`);
  console.log(`"Kusama Asset Hub" — native, no teleport, minimum 0.0105 KSM, fee 0.01 KSM.`);
  process.exit(0);
}

const api = await ApiPromise.create({ provider: new WsProvider(RPC), noInitWarn: true });
const pair = await key();
const addr = ss58(pair);

// ---------------------------------------------------------------- status

if (cmd === "status") {
  console.log(`account  ${addr}`);
  console.log(`         ${fmt(await balances(api, addr))}`);
  const cat = await meter();
  console.log(`\nmeter    ${METER} — ${cat.status === 200 ? `open to you as "${(cat.body as any).you}"` : `refused: ${JSON.stringify(cat.body)}`}`);
  process.exit(0);
}

// ------------------------------------------------------------------ swap

if (cmd === "swap") {
  const want = Number(arg("dusd") ?? "2");
  const out = BigInt(Math.round(want * 1e6));
  const quoted: any = await api.call.assetConversionApi.quotePriceTokensForExactTokens(KSM_LOC, DUSD_LOC, out, true);
  if (quoted.isNone) die("no quote — the pool lookup failed");
  const needed = BigInt(quoted.unwrap().toString());
  const maxIn = (needed * 105n) / 100n;

  console.log(`swapping for exactly ${want} dUSD`);
  console.log(`   quote   ${Number(needed) / 1e12} KSM in (max ${Number(maxIn) / 1e12} with 5% slippage room)`);
  const before = await balances(api, addr);
  console.log(`   before  ${fmt(before)}`);
  if (!flag("confirm")) {
    console.log(`\n   dry run. add --confirm to send.`);
    process.exit(0);
  }
  const block = await send(
    api,
    api.tx.assetConversion.swapTokensForExactTokens([KSM_LOC, DUSD_LOC], out, maxIn, addr, false),
    pair,
  );
  console.log(`   finalised ${block}`);
  const after = await balances(api, addr);
  console.log(`   after   ${fmt(after)}`);
  console.log(`   cost    ${(before.ksm - after.ksm).toFixed(6)} KSM for ${((after.dusd ?? 0) - (before.dusd ?? 0)).toFixed(6)} dUSD`);
  process.exit(0);
}

// ---------------------------------------------------------------- ask/pay

if (cmd === "ask" || cmd === "pay") {
  const sql = (process.argv[3] ?? "").trim();
  if (!sql) die(`usage: bun run buy.ts ${cmd} "SELECT …"`);

  const quote = await meter("", { method: "POST", body: JSON.stringify({ sql }) });
  if (quote.status === 200) {
    console.log(JSON.stringify(quote.body, null, 2));
    process.exit(0);
  }
  if (quote.status !== 402) {
    console.log(JSON.stringify(quote.body, null, 2));
    process.exit(1);
  }

  const { quote: q, payment, sample } = quote.body as any;
  console.log(`quote    ${q.amount_dusd} dUSD for ${q.rows} rows from the full corpus`);
  console.log(`         (${q.breakdown.base} to ask + ${q.breakdown.per_row} a row)`);
  if (cmd === "ask") {
    console.log(`\nfree sample (sessions CS01–CS03), ${sample.rows} rows:`);
    console.log(JSON.stringify(sample.results, null, 2));
    console.log(`\nto buy the full answer: bun run buy.ts pay "${sql.replace(/"/g, '\\"')}" --confirm`);
    process.exit(0);
  }

  const before = await balances(api, addr);
  console.log(`   before  ${fmt(before)}`);
  if (before.dusd === null || before.dusd < q.amount_dusd) {
    die(`not enough dUSD. run: bun run buy.ts swap --dusd=${Math.max(2, Math.ceil(q.amount_dusd))} --confirm`);
  }
  if (!flag("confirm")) {
    console.log(`\n   dry run. add --confirm to pay.`);
    process.exit(0);
  }

  // The signature is not the payment. It binds an already-settled transfer to
  // this payer and this exact query, so nobody else can present your block.
  const sig = "0x" + Buffer.from(pair.sign(createHash("sha256").update(sql, "utf8").digest())).toString("hex");

  // Fee paid in dUSD, not KSM: Asset Hub's ChargeAssetTxPayment swaps it through
  // the pool for you. Passing the bare asset id instead of the MultiLocation
  // fails to encode.
  console.log(`→ paying ${q.amount_dusd} dUSD …`);
  const block = await send(api, api.tx.assets.transfer(DUSD, payment.recipient, BigInt(q.amount)), pair, {
    assetId: DUSD_LOC,
  });
  console.log(`   finalised ${block}`);

  console.log(`→ claiming …`);
  const paid = await meter("", {
    method: "POST",
    body: JSON.stringify({ sql }),
    headers: { "x-payment": `block=${block}; from=${addr}; sig=${sig}` },
  });
  console.log(JSON.stringify(paid.body, null, 2));
  const after = await balances(api, addr);
  console.log(`\n   after   ${fmt(after)}`);
  console.log(`   cost    ${((before.dusd ?? 0) - (after.dusd ?? 0)).toFixed(6)} dUSD (price + fee)`);
  process.exit(paid.status === 200 ? 0 : 1);
}

console.log(`usage: bun run buy.ts <new|status|swap|ask|pay>`);
process.exit(1);
