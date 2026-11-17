# Vendored from browse

These crates come from [browse](https://github.com/anomalyco/browse) (MIT, see [`LICENSE`](LICENSE)), at commit
[`91d67c87bc14929659a9d20a74d2d5b66ddbc43f`](https://github.com/anomalyco/browse/tree/91d67c87bc14929659a9d20a74d2d5b66ddbc43f/rust/crates)
(v0.1.4), from upstream's `rust/crates/`:

| Crate | What agent-browser uses it for |
| --- | --- |
| `browse-core` | The `Browser`, `Cdp` and `Tool` traits agent-browser implements and calls |
| `browse-page` | The page tools, human-like input and challenge detection |
| `browse-capture` | `screenshot` |

`browse-page/js/injected-script.js` is Playwright's InjectedScript (Apache-2.0); see [`NOTICE`](NOTICE).

## Local changes

Every change to upstream's files is marked with an `agent-browser:` comment (`//` in Rust and JavaScript, `#` in
TOML), so `grep -rn "agent-browser:" vendor/browse` lists them. Besides those:

- Tools agent-browser doesn't offer stay in the crates, whose own tests use them; agent-browser leaves them out of
  its registry (`src/tools.rs`).
- `browse-script` (`execute`, agent-written JavaScript run in QuickJS) is left out on purpose: every client gets the
  plain tools, so the server never runs code agents write.
- `browse-page/js/generate.sh` is left out: it regenerates the page scripts from upstream's TypeScript tree.

## Updating

```bash
rev=<new commit>
dir=$(mktemp -d)
curl -fsSL https://codeload.github.com/anomalyco/browse/tar.gz/$rev | tar -xz -C "$dir" --strip-components=1
for crate in browse-core browse-page browse-capture; do
  diff -ru "$dir/rust/crates/$crate" vendor/browse/$crate
done
```

Apply upstream's changes, keep the marked local changes, run `cargo test --workspace`, and update the commit above.
