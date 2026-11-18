# birdbrain-402

The first version of the meter, built in August 2026 from select402's live handshake and run against Kusama Asset Hub mainnet in dUSD. It is kept for its history and for `scripts/attack-tests.ts`, the adversarial checks the payment path has to pass. The meter in the root of this repository replaced it.

What differs from the current meter:

- It pays Decent Partners' account (`FvrbaMus…`), which ran the experiment. The current meter pays the collective whose material it is.
- It keeps claimed transfers in memory, so a restart forgets them. The current meter writes them to disk.
- Its corpus included the Chaos Session transcripts. What is sold now is the graph and the concepts, without the transcripts and without who said what.

| Script | What it does |
| --- | --- |
| `build-corpus.ts` | Builds the corpus from the published graph and the session index (needs the source files, so it only runs where they live). |
| `attack-tests.ts` | Six checks: a second query against one transfer, straight replay, someone else's block, a signature over different SQL, a block with no matching transfer, and a write hidden in the SQL. |
| `agent-query.ts` | A buyer written as an agent would write it. |
| `cold-start.ts` | A buyer starting from nothing: new key, funded, swapped, paid. |
| `fund-buyer.ts` | Swaps a fee-sized amount of KSM for dUSD in the Asset Hub pool. |
| `keys.ts` | Loads keys from environment variables. No key is stored in this repository. |
