# Vendored from browse

These crates come from [browse](https://github.com/anomalyco/browse) (MIT, see [`LICENSE`](LICENSE)), at commit
[`c3b29be5299658281fe4ecdcb926bb7b5a9d6f8c`](https://github.com/anomalyco/browse/tree/c3b29be5299658281fe4ecdcb926bb7b5a9d6f8c/rust/crates)
(v0.1.0), from upstream's `rust/crates/`:

| Crate | What agent-browser uses it for |
| --- | --- |
| `browse-core` | The `Browser`, `Cdp` and `Tool` traits agent-browser implements and calls |
| `browse-page` | The page tools, human-like input and challenge detection |
| `browse-capture` | `screenshot` |
| `browse-script` | `execute`: JavaScript in QuickJS with a Playwright-style `page` |

`browse-page/js/injected-script.js` is Playwright's InjectedScript (Apache-2.0); see [`NOTICE`](NOTICE).

## Local changes

Every change to upstream's files is marked with an `agent-browser:` comment (`//` in Rust and JavaScript, `#` in
TOML), so `grep -rn "agent-browser:" vendor/browse` lists them. Besides those:

- Tools agent-browser doesn't offer stay in the crates, whose own tests use them; agent-browser leaves them out of
  its registry (`src/tools.rs`).
- `browse-page/js/generate.sh` is left out: it regenerates the page scripts from upstream's TypeScript tree.

## Updating

```bash
rev=<new commit>
dir=$(mktemp -d)
curl -fsSL https://codeload.github.com/anomalyco/browse/tar.gz/$rev | tar -xz -C "$dir" --strip-components=1
for crate in browse-core browse-page browse-capture browse-script; do
  diff -ru "$dir/rust/crates/$crate" vendor/browse/$crate
done
```

Apply upstream's changes, keep the marked local changes, run `cargo test --workspace`, and update the commit above.
