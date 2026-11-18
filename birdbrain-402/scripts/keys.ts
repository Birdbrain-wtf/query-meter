// Key loading for the experiment. Reads keystores out of the environment —
// nothing is written to disk and nothing is ever logged beyond the address.

import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import type { KeyringPair } from "@polkadot/keyring/types";

export async function load(jsonEnv: string, pwEnv: string): Promise<KeyringPair> {
  await cryptoWaitReady();
  const raw = process.env[jsonEnv];
  if (!raw) throw new Error(`${jsonEnv} is not set`);
  const kr = new Keyring({ type: "sr25519" });
  const pair = kr.addFromJson(JSON.parse(raw));
  pair.decodePkcs8(process.env[pwEnv]);
  return pair;
}

export const ss58 = (pair: KeyringPair) => encodeAddress(pair.publicKey, 2);

/** The seller: Decent Partners' Kusama account, which holds the dUSD. */
export const seller = () => load("DECENT_PARTNERS_KUSAMA_KEY", "DECENT_PARTNERS_KUSAMA_KEY_PASSWORD");

/** The buyer: Birdbrain's admin key, standing in for a paying agent. */
export const buyer = () => load("BIRDBRAIN_ADMIN_KEY_JSON", "BIRDBRAIN_ADMIN_KEY_PASSWORD");
