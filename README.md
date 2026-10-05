# Databricks Cell Runner (VS Code extension)

Run Databricks notebook-source `.py` files cell-by-cell from VS Code against a
remote Databricks cluster via **Databricks Connect** — a local, Jupyter-like
experience backed by persistent per-notebook Python sessions.

## Build and install the extension

Requires Node.js and the [vsce](https://github.com/microsoft/vscode-vsce) CLI
(one-time setup):

```bash
npm install -g @vscode/vsce
```

Build a `.vsix` package from the repo root:

```bash
vsce package
```

This produces `spark-cell-runner-0.2.0.vsix`. Install it into VS Code:

```bash
code --install-extension spark-cell-runner-0.2.0.vsix
```

Then reload VS Code (or run **Developer: Reload Window**) and check the
Databricks Cell Runner icon in the activity bar. To uninstall:
`code --uninstall-extension PrashanthReddyMunagala.spark-cell-runner`.

> No build/compile step is needed — the extension is plain CommonJS JavaScript
> plus Python resources in `src/python/`, which `vsce` packages as-is
> (see `.vscodeignore`).

## Project layout

```
src/
  extension.js        Entry point: activate()/deactivate() wiring only
  constants.js        Shared constants and magic-line regexes
  state.js            Shared mutable singletons (sessions, caches, output channel)
  config.js           sparkCellRunner configuration access + helpers
  commands.js         All vscode.commands registrations
  parser.js           Notebook-source parsing, cell splitting, magic handling
  serializer.js       Notebook <-> "# Databricks notebook source" .py serialization
  codelens.js         Run / preview CodeLenses in the text editor view
  navigation.js       Go to Definition / Find References remapping for cells
  scriptBuilder.js    Generated-script construction, %run expansion, magic translation
  session.js          Persistent per-notebook python session processes (JSON stdio protocol)
  runner.js           Run orchestration + notebook controllers
  pythonEnv.js        Interpreter discovery, Databricks Connect validation, child env
  pyResources.js      Loads the Python templates below and injects settings
  python/
    bootstrap.py      Databricks bootstrap: spark/sql creation, dbutils proxies,
                      path translation, logging helpers (was hardcoded in JS)
    runtime_data.py   Per-run widget/secret/path-mapping values (template)
    session_driver.py Long-lived python process that executes code blocks over stdio
  ui/
    sidebar.js        Activity-bar webview (workspace + settings panels)
    statusBar.js      Status bar item (interpreter / profile / cluster)
    decorations.js    Per-cell run state decorations + run-state store
    resultPanel.js    Results webview (summary / stdout / stderr / script)
```

## Python sources

The bootstrap, runtime data, and session driver used to be hardcoded as JS
string arrays inside a single 4,300-line `extension.js`. They now live as real
Python files in `src/python/`, so you can read and edit them with proper syntax
highlighting. `pyResources.js` loads them at runtime and substitutes small
`__DCR_*__` placeholders (builder line, widget values, etc.) from workspace
settings. The session driver is spawned directly as a script file.

The original monolithic files are preserved in `_legacy_backup/` and can be
deleted once the restructured version has been verified against a real cluster.

## Testing and UI preview

See [test/README.md](test/README.md). In short:

- `npm run preview:ui` renders the sidebar and results-panel HTML to
  `test/preview/` — open it in a browser to iterate on the UI with no reload.
- **F5** launches an Extension Development Host on the `test/` workspace with a
  sample notebook (widgets, `%sql`, `%run`).
- JS changes need an extension-host reload (**Ctrl+R** in the dev host);
  `src/python/*.py` template changes are picked up on the next run.
