// Give the buyer a float of dUSD to spend on queries.
//
// The seller account holds the dUSD but effectively no KSM (0.000003), so the
// fee is paid in dUSD itself via the ChargeAssetTxPayment signed extension —
// the runtime swaps it through the KSM/dUSD pool on Asset Hub. That pool is
// thin (see decent-kreivo/TREASURY-FUNDING.md) but a fee-sized swap is well
// inside it.
//
//   bun run scripts/fund-buyer.ts [amount_dusd]

import { ApiPromise, WsProvider } from "@polkadot/api";
import { seller, buyer, ss58 } from "./keys.ts";

const DUSD = 50000002;
const DUSD_LOCATION = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: DUSD }] } };

const amount = BigInt(Math.round(Number(process.argv[2] ?? "1") * 1e6));

const api = await ApiPromise.create({ provider: new WsProvider("wss://kusama-asset-hub-rpc.polkadot.io"), noInitWarn: true });
const from = await seller();
const to = await buyer();

const bal = async (a: string) => {
  const r: any = await api.query.assets.account(DUSD, a);
  return r.isSome ? Number(r.unwrap().balance.toString()) / 1e6 : 0;
};

console.log(`seller ${ss58(from)}  ${await bal(ss58(from))} dUSD`);
console.log(`buyer  ${ss58(to)}  ${await bal(ss58(to))} dUSD`);
console.log(`\nsending ${Number(amount) / 1e6} dUSD, fee paid in dUSD …`);

const tx = api.tx.assets.transfer(DUSD, ss58(to), amount);

await new Promise<void>((resolve, reject) => {
  tx.signAndSend(from, { assetId: DUSD_LOCATION }, ({ status, dispatchError, txHash }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => {
            const d = api.registry.findMetaError(dispatchError.asModule);
            return `${d.section}.${d.name}: ${d.docs.join(" ")}`;
          })()
        : dispatchError.toString();
      return reject(new Error(msg));
    }
    if (status.isInBlock) console.log(`  in block ${status.asInBlock.toHex()}  tx ${txHash.toHex()}`);
    if (status.isFinalized) {
      console.log(`  finalised ${status.asFinalized.toHex()}`);
      resolve();
    }
  }).catch(reject);
});

console.log(`\nseller ${await bal(ss58(from))} dUSD`);
console.log(`buyer  ${await bal(ss58(to))} dUSD`);
process.exit(0);
