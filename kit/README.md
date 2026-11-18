# Buying a query from Birdbrain

Birdbrain sells its world model by the row, for dUSD on Kusama Asset Hub. Anyone
can ask. No key, no account, no sign-up. Payment is the only gate.

Endpoint: `https://birdbrain.wtf/query`

## What you are buying

One SQLite database you query with ordinary SQL.

The **graph**: 713 nodes and 880 edges covering 29 Chaos Sessions and the
people, topics, questions and decisions in them. The same graph is published to
Fangorn and anchored on Kusama Asset Hub, so it can be checked against the chain
rather than taken on trust.

The **concepts** extracted from those sessions: 183 of them, each with a session,
a date and a timestamp. They do not say who said what.

What is not for sale: the transcripts. Those are people's own words, and they
stay with the people who said them.

| Table | What is in it |
| --- | --- |
| `vertices` | `key · schema · type · label · date · day_count · summary · url · data` |
| `edges` | `label · from_key · to_key`: attended, has-topic, surfaces, raises, raised |
| `concepts` | `id · session · date · name · summary · timestamp` |
| `vertices_fts` | FTS5 over node labels and summaries |

`GET /query/manifest.json` returns the live schema and row counts.

## The price

0.01 dUSD to ask, plus 0.001 for each row delivered. A hundred-row query costs
eleven cents. Rows scanned are not metered.

Quotes are exact. The count runs against the full corpus for free, and you pay
only for what comes back. A query that returns nothing costs the base fee.

## Four steps

**1. Make a key.** It is generated on your machine and the mnemonic stays there.

```bash
mkdir birdbrain && cd birdbrain && bun init -y
bun add @polkadot/api @polkadot/keyring @polkadot/util-crypto
curl -O https://birdbrain.wtf/query/buy.ts
bun run buy.ts new
```

**2. Get KSM to that address.** Any exchange that withdraws to Kusama Asset Hub
directly works. A couple of KSM is plenty.

```bash
bun run buy.ts status
```

**3. Swap a little of it for dUSD.** dUSD is asset 50000002 on Asset Hub. The
swap opens your dUSD account for you.

```bash
bun run buy.ts swap --dusd=2 --confirm
```

The pool is thin, so keep single swaps small.

**4. Ask, then buy.**

```bash
bun run buy.ts ask "SELECT label, date FROM vertices WHERE type = 'decision' LIMIT 5"
bun run buy.ts pay "SELECT label, date FROM vertices WHERE type = 'decision' LIMIT 5" --confirm
```

`ask` is free. It quotes the full corpus and runs your query against a free
sample (the first three sessions and everything one hop from them), so you can
get the query right before paying for it.

`pay` transfers the quoted dUSD, waits for finality and presents the block as
proof. Nothing moves without `--confirm`. Asset Hub takes the transaction fee out
of the dUSD, so you need no KSM for the query itself.

Not using the script? `POST /query` with `{"sql": "…"}` returns the quote, the
sample rows and the exact payment instructions in a 402 response. Pay, then send
the same request with `X-Payment: block=0x…; from=<ss58>; sig=0x…`.

## How the payment works

There is no invoice and no permission to pull funds. You transfer dUSD to
Birdbrain's own account, wait for the block to finalise, then present the block
hash with a signature over `sha256(your query)`. The signature binds a transfer
that has already settled to you and to that one query, so nobody else can present
your block, and you cannot present it twice.

Four checks: the signature binds you to this query, the block is canonical and
final, it holds a successful dUSD transfer from you to Birdbrain of at least the
quote, and that transfer has not been claimed before.

Finality takes 30 to 60 seconds. That is the cost of settling first.

## What is recorded

Every request: the query, the quote, and for a purchase the block, extrinsic,
payer address and amount. Nothing else about you.

After a purchase the meter also notes which graph nodes your rows contained,
with the amount paid and without your address. That tells Birdbrain's members
which parts of their world model people outside pay to read. The money goes to
Birdbrain's treasury and is not yet shared out to contributors. How it is spent
is for the members to decide.

## Limits

- SELECT only, one statement, 500 rows at most, 5 seconds per query.
- The corpus is a snapshot, rebuilt by hand.
- You get rows, not an answer written for you.
- What you may do with what you buy has not been settled. Ask first if it matters.

Questions: `#birdbrain:matrix.org`.
