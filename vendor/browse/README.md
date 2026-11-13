# Vendored from browse

These files come from [browse](https://github.com/anomalyco/browse) (MIT, see
[`LICENSE`](LICENSE)), at commit
[`53eb63dd17339053d5df5736721ad637158d1d31`](https://github.com/anomalyco/browse/tree/53eb63dd17339053d5df5736721ad637158d1d31/cli/src/execute).
The directory layout mirrors upstream's `cli/src/`, so the files' own imports work unchanged.

| File | Upstream path | SHA-256 of the upstream file |
| --- | --- | --- |
| `execute/human-input.ts` | `cli/src/execute/human-input.ts` | `eaeecb109c3b2aca0bbd68aa55301d6e9a4035fc59438e047397182d43087890` |
| `execute/challenge-detection.ts` | `cli/src/execute/challenge-detection.ts` | `e47f826fca6886ca22491e6ae62954fc59ad998f4ea1afe457d9544a1e942edf` |
| `execute/patchright-tuning.ts` | `cli/src/execute/patchright-tuning.ts` | `b3f3377f9728a5200be5db0bd7b1d24b84632cc52929fca2e90eb99362ab8d79` |
| `test/human-input.test.ts` | `cli/test/human-input.test.ts` | ported from `bun:test` to `node:test` |
| `test/challenge-detection.test.ts` | `cli/test/challenge-detection.test.ts` | ported from `bun:test` to `node:test` |

## Local changes

Changes to the copied sources are wrapped in `agent-browser change` comments:

- `execute/challenge-detection.ts`, `challengeWarning`: the interactive-challenge
  message no longer tells the agent to call browse's `handoff()`, which agent-browser
  doesn't have.

The files' only dependencies on the rest of browse are replaced by shims:

- `protocol.ts`: the `JsonObject` type.
- `relay/log.ts`: `relayLog`, which logs through agent-browser's debug logger.

The tests were ported to `node:test` and `node:assert`, and the `handoff()`
expectation in `challengeWarning`'s test follows the change above.

## Updating

```bash
rev=<new commit>
mkdir -p /tmp/browse-$rev && curl -fsSL https://codeload.github.com/anomalyco/browse/tar.gz/$rev | tar -xz -C /tmp/browse-$rev --strip-components=1
for f in human-input challenge-detection patchright-tuning; do
  diff -u <(git show HEAD:vendor/browse/execute/$f.ts) /tmp/browse-$rev/cli/src/execute/$f.ts
done
```

Apply upstream's changes, keep the marked local changes, and update the commit
and hashes above.
