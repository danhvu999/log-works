# Releasing log-works

How to cut a new release and publish it on GitHub.

## TL;DR

```bash
# 1. bump version in package.json
# 2. commit + push to main
git push origin main

# 3. tag and push
git tag v0.2.0
git push origin v0.2.0

# 4. wait for the `release` workflow to finish
gh run watch
```

That's it. The workflow runs `bun pm pack` (typecheck + lint + test + build), packs `log-works-<version>.tgz`, and attaches it to a new GitHub Release with auto-generated notes.

## Pre-flight (every release)

Run locally before tagging:

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build               # → dist/{mcp,cli}.js
node dist/mcp.js < /dev/null  # MCP boots under Node (Ctrl-C after a sec)
node dist/cli.js --help     # CLI boots under Node
bun pm pack --dry-run       # tarball assembles, runs the full prepack chain
```

All must pass. The CI workflow runs the same chain — failing here is the cheapest place to catch it.

## Bumping the version

Edit `package.json` directly:

```jsonc
{ "version": "0.2.0" }
```

Follow semver:

- **patch** (`0.1.0 → 0.1.1`): bug fixes, doc-only changes.
- **minor** (`0.1.0 → 0.2.0`): new tools, new flags, new optional config keys.
- **major** (`0.1.0 → 1.0.0`): breaking changes to CLI contract, MCP tool shapes, or config schema. Note breaking changes in the commit message body (`BREAKING CHANGE:`).

The tag name **must** match `package.json` version with a `v` prefix: package `0.2.0` → tag `v0.2.0`. The workflow trigger is `tags: ['v*']`.

## Tagging

Tag the commit that should be released (usually the latest on `main`):

```bash
git tag v0.2.0
git push origin v0.2.0
```

To tag an earlier commit:

```bash
git tag v0.2.0 <commit-sha>
git push origin v0.2.0
```

Pushing the tag triggers `.github/workflows/release.yml`.

## Verifying a release

After CI finishes:

```bash
gh release view v0.2.0
# Assets should list log-works-0.2.0.tgz

# Spot-check the tarball is fetchable
curl -sIL "https://github.com/danhvu999/log-works/releases/download/v0.2.0/log-works-0.2.0.tgz" \
  -o /dev/null -w "%{http_code}\n"     # → 200
```

Smoke-test the install on a clean dir:

```bash
mkdir /tmp/lwk-verify && cd /tmp/lwk-verify
npm init -y >/dev/null
npm i "https://github.com/danhvu999/log-works/releases/download/v0.2.0/log-works-0.2.0.tgz"
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
  | timeout 2 node_modules/.bin/log-works-mcp \
  | head -c 200      # expect a JSON-RPC response with serverInfo.name="log-works"
node_modules/.bin/log-works --help    # commander help
```

Also smoke-test the git-URL install (Bun users):

```bash
bun add -g github:danhvu999/log-works#v0.2.0
log-works-mcp < /dev/null              # boots under Node via the symlink
bun remove -g log-works
```

## When CI fails

```bash
gh run list --workflow=release.yml --limit 5
gh run view <run-id> --log-failed
```

Common failure modes:

| Failure | Cause | Fix |
| --- | --- | --- |
| `tsc --noEmit` errors | Type regression | Fix on `main`, force-update the tag: `git tag -f v0.2.0 && git push -f origin v0.2.0` (only if no one has already installed the tag). |
| `biome check` errors | Formatting / lint regression | Same as above. |
| `bun test` failure | Real test failure, or test leaking into `~/.log-works/db.json` on the runner | Tests should pin `storage.path` to a temp dir — see `tests/setup.service.test.ts` for the pattern. |
| `bun build` failure | Source no longer bundles for Node target (e.g. a Bun-only API used in `src/`) | Replace the Bun-specific call or move it behind a runtime check. |
| `softprops/action-gh-release` 403 | Workflow permissions | Confirm `.github/workflows/release.yml` has `permissions: contents: write`. |
| Release exists but `.tgz` missing | Workflow exited before the `Create GitHub Release` step | Re-trigger by deleting + retagging. |

### Re-running a failed release

If the tag is already pushed and the run failed:

```bash
# delete the broken release + tag locally and remotely
gh release delete v0.2.0 --yes 2>/dev/null
git push origin :refs/tags/v0.2.0
git tag -d v0.2.0

# fix the underlying issue on main, commit, push
git push origin main

# retag and re-trigger
git tag v0.2.0
git push origin v0.2.0
```

Force-pushing a tag (`git push -f`) is acceptable here as long as no consumer has already installed `v0.2.0` — once published, treat the tag as immutable and bump to `v0.2.1` instead.

## Hotfix path

For an urgent fix on an existing release:

1. Branch from the release tag: `git checkout -b hotfix/0.2.1 v0.2.0`.
2. Apply the fix, bump to `0.2.1` in `package.json`, commit.
3. Merge into `main` (fast-forward or PR).
4. Tag `v0.2.1` on `main` after merge, push.

## Manual fallback (if Actions is down)

```bash
bun pm pack          # → log-works-<version>.tgz
gh release create v0.2.0 ./log-works-0.2.0.tgz --generate-notes
```

This produces the same artifact the CI workflow would.

## What ships in the tarball

Only what's listed in `package.json#files`:

- `dist/` — pre-built `mcp.js` + `cli.js` (Node-compatible ESM, with shebangs).
- `README.md`
- `package.json` (always included by `npm pack`).

Excluded: `src/`, `tests/`, `fixtures/`, `docs/`, `.github/`, `bun.lock`. Consumers get a ~1.1 MB packed tarball with both bins ready to run under Node 20+.
