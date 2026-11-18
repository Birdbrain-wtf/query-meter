/**
 * The stranger's path, walked with a throwaway account.
 *
 *   exchange → Kusama Asset Hub → KSM:dUSD swap → pay for a query
 *
 * Everything before this script proved the meter works between two accounts we
 * already funded. This proves the part a buyer actually has to do: arrive
 * holding nothing but KSM and leave holding rows. The cold account starts with
 * no KSM, no dUSD asset account, and no relationship with us.
 *
 * The one step it cannot perform is the exchange leg. Kraken withdraws KSM
 * natively to Asset Hub (method "Kusama Asset Hub", minimum 0.0105 KSM, fee
 * 0.01 KSM), so there is no teleport and no relay hop - but a withdrawal needs
 * a funded exchange account, and ours holds £1.59. `fund` therefore sends the
 * KSM from Decent Partners instead, and says so rather than pretending.
 *
 *   bun run scripts/cold-start.ts status
 *   bun run scripts/cold-start.ts new
 *   bun run scripts/cold-start.ts fund  --ksm=0.3  --confirm
 *   bun run scripts/cold-start.ts touch            --confirm
 *   bun run scripts/cold-start.ts swap  --dusd=1   --confirm
 *   bun run scripts/cold-start.ts query "SELECT label FROM vertices LIMIT 3"
 *
 * Nothing moves without --confirm. Every step prints the balances either side
 * of it, because the cost of each leg is the thing worth recording.
 */

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";
import type { KeyringPair } from "@polkadot/keyring/types";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { seller, ss58 } from "./keys.ts";

const ENDPOINT = process.env.BB402 || "http://localhost:3702";
const RPC = "wss://kusama-asset-hub-rpc.polkadot.io";
const DUSD = 50000002;
const DUSD_LOC = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: DUSD }] } };
const KSM_LOC = { parents: 1, interior: "Here" };
const KEYFILE = "./secrets/cold-start-buyer/mnemonic";

const cmd = process.argv[2];
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const flag = (n: string) => process.argv.includes(`--${n}`);

async function cold(): Promise<KeyringPair> {
  await cryptoWaitReady();
  if (!existsSync(KEYFILE)) throw new Error(`no cold key yet - run: bun run scripts/cold-start.ts new`);
  const kr = new Keyring({ type: "sr25519" });
  return kr.addFromMnemonic(readFileSync(KEYFILE, "utf8").trim());
}

function connect() {
  return ApiPromise.create({ provider: new WsProvider(RPC), noInitWarn: true });
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
  `${b.ksm.toFixed(6)} KSM  ·  ${b.dusd === null ? "no dUSD account" : `${b.dusd.toFixed(6)} dUSD`}`;

/** Sign, send, wait for finality. Returns the finalised block hash. */
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

if (cmd === "new") {
  await cryptoWaitReady();
  if (existsSync(KEYFILE)) {
    const pair = await cold();
    console.log(`cold account already exists: ${ss58(pair)}`);
    process.exit(0);
  }
  const phrase = mnemonicGenerate();
  mkdirSync("./secrets/cold-start-buyer", { recursive: true });
  writeFileSync(KEYFILE, phrase + "\n");
  chmodSync(KEYFILE, 0o600);
  const kr = new Keyring({ type: "sr25519" });
  console.log(`cold account created: ${ss58(kr.addFromMnemonic(phrase))}`);
  console.log(`mnemonic written to ${KEYFILE} (0600, untracked)`);
  process.exit(0);
}

const api = await connect();
const pair = await cold();
const addr = ss58(pair);

if (cmd === "status") {
  const dp = await seller();
  console.log(`cold buyer   ${addr}`);
  console.log(`             ${fmt(await balances(api, addr))}`);
  console.log(`\nfunder (DP)  ${ss58(dp)}`);
  console.log(`             ${fmt(await balances(api, ss58(dp)))}`);
  console.log(`\nassetAccountDeposit ${Number(api.consts.assets.assetAccountDeposit.toString()) / 1e12} KSM`);
  console.log(`existentialDeposit  ${Number(api.consts.balances.existentialDeposit.toString()) / 1e12} KSM`);
  process.exit(0);
}

if (cmd === "fund") {
  const ksm = Number(arg("ksm") ?? "0.3");
  const dp = await seller();
  console.log(`stand-in for the exchange withdrawal: ${ksm} KSM, Decent Partners → cold buyer`);
  console.log(`   before  ${fmt(await balances(api, addr))}`);
  if (!flag("confirm")) {
    console.log(`\n   dry run. add --confirm to send.`);
    process.exit(0);
  }
  const block = await send(api, api.tx.balances.transferKeepAlive(addr, BigInt(Math.round(ksm * 1e12))), dp);
  console.log(`   finalised ${block}`);
  console.log(`   after   ${fmt(await balances(api, addr))}`);
  process.exit(0);
}

if (cmd === "touch") {
  console.log(`opening a dUSD asset account for ${addr}`);
  const before = await balances(api, addr);
  console.log(`   before  ${fmt(before)}`);
  if (before.dusd !== null) {
    console.log(`   already open - nothing to do.`);
    process.exit(0);
  }
  if (!flag("confirm")) {
    console.log(`\n   dry run. add --confirm to send.`);
    process.exit(0);
  }
  const block = await send(api, api.tx.assets.touch(DUSD), pair);
  console.log(`   finalised ${block}`);
  const after = await balances(api, addr);
  console.log(`   after   ${fmt(after)}`);
  console.log(`   cost    ${(before.ksm - after.ksm).toFixed(6)} KSM (deposit + fee)`);
  process.exit(0);
}

if (cmd === "swap") {
  const dusd = Number(arg("dusd") ?? "1");
  const out = BigInt(Math.round(dusd * 1e6));
  const quoted: any = await api.call.assetConversionApi.quotePriceTokensForExactTokens(KSM_LOC, DUSD_LOC, out, true);
  if (quoted.isNone) throw new Error("no quote - pool lookup failed");
  const needed = BigInt(quoted.unwrap().toString());
  const maxIn = (needed * 105n) / 100n;
  console.log(`swapping for exactly ${dusd} dUSD`);
  console.log(`   quote   ${Number(needed) / 1e12} KSM in  (max ${Number(maxIn) / 1e12} with 5% slippage room)`);
  const before = await balances(api, addr);
  console.log(`   before  ${fmt(before)}`);
  if (!flag("confirm")) {
    console.log(`\n   dry run. add --confirm to send.`);
    process.exit(0);
  }
  const tx = api.tx.assetConversion.swapTokensForExactTokens([KSM_LOC, DUSD_LOC], out, maxIn, addr, false);
  const block = await send(api, tx, pair);
  console.log(`   finalised ${block}`);
  const after = await balances(api, addr);
  console.log(`   after   ${fmt(after)}`);
  console.log(`   cost    ${(before.ksm - after.ksm).toFixed(6)} KSM for ${((after.dusd ?? 0) - (before.dusd ?? 0)).toFixed(6)} dUSD`);
  process.exit(0);
}

if (cmd === "query") {
  const sql = (process.argv[3] ?? "").trim();
  if (!sql) throw new Error('usage: cold-start.ts query "SELECT …"');

  const ask = (headers: Record<string, string> = {}) =>
    fetch(`${ENDPOINT}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ sql }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  console.log(`→ quoting …`);
  const free = await ask();
  if (free.status !== 402) {
    console.log(JSON.stringify(free.body, null, 2));
    process.exit(free.status === 200 ? 0 : 1);
  }
  const { quote, payment } = free.body as any;
  console.log(`   ${quote.amount_dusd} dUSD for ${quote.rows} rows`);

  const before = await balances(api, addr);
  console.log(`   before  ${fmt(before)}`);
  if (!flag("confirm")) {
    console.log(`\n   dry run. add --confirm to pay.`);
    process.exit(0);
  }

  const sig = "0x" + Buffer.from(pair.sign(createHash("sha256").update(sql, "utf8").digest())).toString("hex");
  console.log(`→ paying ${quote.amount_dusd} dUSD, fee in dUSD …`);
  const block = await send(api, api.tx.assets.transfer(DUSD, payment.recipient, BigInt(quote.amount)), pair, {
    assetId: DUSD_LOC,
  });
  console.log(`   finalised ${block}`);

  console.log(`→ claiming …`);
  const paid = await ask({ "x-payment": `block=${block}; from=${addr}; sig=${sig}` });
  console.log(JSON.stringify(paid.body, null, 2));
  const after = await balances(api, addr);
  console.log(`\n   after   ${fmt(after)}`);
  console.log(`   cost    ${((before.dusd ?? 0) - (after.dusd ?? 0)).toFixed(6)} dUSD (price + fee)`);
  process.exit(paid.status === 200 ? 0 : 1);
}

console.log(`usage: bun run scripts/cold-start.ts <status|new|fund|touch|swap|query>`);
process.exit(1);
