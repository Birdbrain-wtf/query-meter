# Lineage

## Where the idea came from

[x402](https://www.x402.org) brought back HTTP 402 Payment Required as a way for agents to pay per request. Its payments are a signed permission that a facilitator pulls against, which expects Ethereum- or Solana-style keys. A Polkadot account with an sr25519 key can't produce that signature, so it can't take part.

Karim Jedda's [select402](https://select402.com) showed another way: keep the 402, drop the permit, and use the chain's own keys. The buyer transfers first, then presents the block with a signature over `sha256(sql)`. It sells SQL over SQLite on Paseo Asset Hub, paid in PAS, with a free sample and a priced full corpus. The code went public on 18 November 2026 at [KarimJedda/select402](https://github.com/KarimJedda/select402), as a proof of concept for testnet only.

We built `birdbrain-402/` in August 2026 by reading select402's live handshake, before its code was public. The two codebases share no code. The handshake is the same on purpose, so a client written for one is most of the way to the other.

## What we changed

| | select402 | here |
| --- | --- | --- |
| Chain and money | Paseo Asset Hub, PAS (testnet) | Kusama Asset Hub, dUSD (mainnet) |
| Fee for the buyer's transfer | native token | paid in dUSD via `ChargeAssetTxPayment`, so no KSM is needed |
| Price | base + rows scanned + rows returned, estimated | base + rows returned, exact |
| Claimed transfers | kept in memory | kept in SQLite across restarts |
| Who is paid | one address for the whole server | the collective whose material it is, set per collective |
| Language | Python | TypeScript on Bun |

**The price.** Scanning is the seller's cost, not something the buyer can see or reason about. Charging for it makes a one-row count over a large table cost the same as reading every row. We run the count for free on the full corpus and charge only for the rows that come back, so the quote is exact.

**Claimed transfers.** The signature stops a third party claiming your payment. It can't stop the payer signing a second query against the same transfer, so the server has to remember which transfers are already spent. We raised this with Karim in August 2026, and select402's public code now keys its spent set on the transfer too. Ours also writes the set to disk, because a set held in memory forgets every past payment when the server restarts.

## Where it goes next

Two things are open, and we'd rather line up with others than invent them alone:

1. A shared header and receipt format for a Substrate-native 402, so a buyer written for one seller works with the next.
2. Whether buyers would rather settle first, as here, or sign a permission the seller pulls against.

Talk to us at [#birdbrain:matrix.org](https://matrix.to/#/%23birdbrain:matrix.org).
