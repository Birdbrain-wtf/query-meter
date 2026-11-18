# query-meter

Pay per query over a collective's own material, settled in dUSD on Kusama Asset Hub.

Live at **https://birdbrain.wtf/query**, selling Birdbrain's world model as SQL. Anyone can ask. There's no account, no key and no sign-up. Payment is the only gate.

## How it works

1. **Ask.** POST your SQL. The meter answers HTTP 402 with an exact quote and the same query run against the free sample, so you can get the query right before paying.
2. **Pay.** Transfer the quoted dUSD (asset 50000002) to the collective's own account and wait for finality. Asset Hub takes the fee in dUSD, so a buyer needs no KSM for the query itself.
3. **Claim.** Send the same request again with an `X-Payment` header: the block hash, your address, and an sr25519 or ed25519 signature over `sha256(sql)`. The signature ties the settled transfer to you and to that one query. Each transfer can be claimed once, and the record of claimed transfers survives a restart.

The price is a base fee plus a fee per row returned (0.01 dUSD and 0.001 dUSD on Birdbrain's meter, up to 500 rows). Rows scanned are not charged, and the quote is exact: the count runs free against the full corpus.

## What is in this repository

| Path | What it is |
| --- | --- |
| `engine/server.ts` | The meter. One collective per process, chosen by `COLLECTIVE` or `--collective`. |
| `engine/sql-runner.ts` | Runs buyer SQL in a child process with a deadline, so one heavy query can't hold the meter. |
| `collectives/birdbrain.json` | Birdbrain's config: recipient, databases, pricing, catalogue text. |
| `adapters/birdbrain-graph.ts` | Builds what is sold from the full corpus, with transcripts and speaker names removed. |
| `kit/` | What a buyer gets, also served by the meter at `/query/buy.ts` and `/query/README.md`. |
| `scripts/` | Our own test buyer, and `demand.ts`, which reads the demand ledger: which graph nodes paid queries returned. A demand signal for members, not a payout. |
| `deploy-birdbrain.sh` | Deploys to Birdbrain's server behind nginx. |
| `birdbrain-402/` | The first version, from August 2026, kept for its history and its replay tests. |

The databases are not in the repository. The full graph is what is sold, and the free sample is served at `/query/sample.db`.

## Running your own

```bash
bun install
cp collectives/birdbrain.json collectives/<you>.json   # set recipient, db paths, tables
COLLECTIVE=<you> PORT=3704 bun run engine/server.ts
```

`recipient` should be the account of the group whose material it is. Set `"open": false` to require a named buyer key (`X-Buyer-Key`), read from `QM_KEYS` (default `./buyers.json`).

## Where it comes from

The shape is Karim Jedda's [select402](https://select402.com), now public at [KarimJedda/select402](https://github.com/KarimJedda/select402). See [LINEAGE.md](LINEAGE.md) for what we took and what we changed.

## Status

The payment path has settled real transfers on mainnet, but every one came from keys we hold. No outside buyer has paid yet.

Questions: [#birdbrain:matrix.org](https://matrix.to/#/%23birdbrain:matrix.org).

## Licence

AGPL-3.0, the same as select402.
