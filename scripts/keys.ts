// Key loading for the buyer side. Keystores are read out of the environment —
// nothing is written to disk and nothing is ever logged beyond the address.
//
// The buyer is deliberately a parameter rather than a constant. birdbrain-402
// hard-coded it, which is exactly why that experiment could only ever be a
// closed loop between two keys we already held. Naming the env pair at the call
// site is what lets an outside buyer turn up without a code change.

import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import type { KeyringPair } from "@polkadot/keyring/types";

export async function load(jsonEnv: string, pwEnv: string): Promise<KeyringPair> {
  await cryptoWaitReady();
  const raw = process.env[jsonEnv];
  if (!raw) throw new Error(`${jsonEnv} is not set`);
  const pair = new Keyring({ type: "sr25519" }).addFromJson(JSON.parse(raw));
  pair.decodePkcs8(process.env[pwEnv]);
  return pair;
}

/** Kusama Asset Hub and Kreivo are both ss58 prefix 2. */
export const ss58 = (pair: KeyringPair) => encodeAddress(pair.publicKey, 2);

/**
 * Whoever is paying. Defaults to the Birdbrain admin key because that is the
 * account holding dUSD today; override with BUYER_KEY_JSON / BUYER_KEY_PASSWORD
 * for anyone else, including a genuinely external buyer.
 */
export const buyer = () =>
  load(
    process.env.BUYER_KEY_JSON ? "BUYER_KEY_JSON" : "BIRDBRAIN_ADMIN_KEY_JSON",
    process.env.BUYER_KEY_JSON ? "BUYER_KEY_PASSWORD" : "BIRDBRAIN_ADMIN_KEY_PASSWORD",
  );
