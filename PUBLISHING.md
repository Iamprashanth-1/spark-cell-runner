# Publishing to the VS Code Marketplace

Step-by-step for publishing `PrashanthReddyMunagala.spark-cell-runner`. The
one-time setup (sections 1-3) needs your Microsoft account and can only be
done by you; everything after that is two commands per release.

## 1. Create the publisher (one-time)

The `publisher` field in `package.json` is `PrashanthReddyMunagala`; create
that publisher if it doesn't exist yet:

1. Go to <https://marketplace.visualstudio.com/manage>.
2. Sign in with a Microsoft account and create an **Azure DevOps
   organization** if prompted (any name works; it is only used for
   authentication).
3. On the publisher creation page, set **ID** to exactly
   `PrashanthReddyMunagala` (it must match `package.json`).

## 2. Push the repository (one-time)

`package.json` points at
<https://github.com/PrashanthReddyMunagala-POC/spark-cell-runner>. The
Marketplace renders the README with links resolved against this repository,
so it should exist and be public:

```bash
git init            # already done if .git/ exists
git add .
git commit -m "Spark Cell Runner 0.3.4"
git remote add origin  https://github.com/Iamprashanth-1/spark-cell-runner.git
git push -u origin main
```

(Create the repo on GitHub first; keep it public, or the README links will
404 on the Marketplace.)

## 3. Create a Personal Access Token (one-time, ~6 months validity)

1. Go to <https://dev.azure.com/<your-org>/_usersSettings/tokens>.
2. **New Token** → name it `vsce-marketplace`.
3. Organization: **All accessible organizations**.
4. Scopes: **Custom defined → Marketplace → Manage** (that single scope is
   enough; tick "Acquire and manage" if shown).
5. Create and **copy the token now** — it is shown only once.

## 4. Publish

```bash
npx vsce login PrashanthReddyMunagala    # paste the PAT when prompted (stored locally)
npx vsce publish                          # publishes the current package.json version
```

Or in one step: `npx vsce publish -p <PAT>`.

`vsce` refuses to publish the same version twice — bump first:

```bash
npx vsce publish patch    # 0.3.4 -> 0.3.5, packages and publishes
npx vsce publish minor    # 0.3.4 -> 0.4.0
npx vsce publish major    # 0.3.4 -> 1.0.0
```

First-time publishes can take a few minutes to appear on
<https://marketplace.visualstudio.com/items?itemName=PrashanthReddyMunagala.spark-cell-runner>.

## 5. Before every release — checklist

- [ ] Bump `version` in `package.json` (or use `vsce publish patch|minor|major`).
- [ ] Update the sidebar footer version in `src/ui/sidebar.js` (search `v0.3.`).
- [ ] `npx vsce package` — check the file list for leaks (`spark-warehouse/`,
      `__pycache__/`, `.vsix` files must NOT appear; they are gitignored/vsceignored).
- [ ] `py -3.10 -m py_compile src/python/*.py` — the Marketplace audience runs
      unknown Python versions; 3.10 is the compatibility floor.
- [ ] README badge-free and accurate; LICENSE present; icon is a 128x128 PNG.

## 6. Managing a published extension

```bash
npx vsce show PrashanthReddyMunagala.spark-cell-runner   # version history
npx vsce unpublish PrashanthReddyMunagala.spark-cell-runner  # remove entirely (careful)
```

You can also deprecate/unpublish and edit the listing (description, contact)
at <https://marketplace.visualstudio.com/manage>. Reviews and Q&A appear in
the same place.

## Notes

- The Marketplace serves the **packaged README and LICENSE**, so both must
  stay inside the `.vsix` (they are; `examples/` and `test/` are excluded via
  `.vscodeignore`).
- Sign into `vsce` on each machine that publishes; the PAT lives in the local
  vsce credential store, never in the repo.
- If an upload is rejected with a publisher/validation error, re-check that
  the publisher ID in `package.json` matches the one created in section 1.
