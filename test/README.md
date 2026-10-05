# Test / preview harness

This folder lets you see and test the extension without packaging it.

## 1. Preview the webview UI instantly (no reload)

```bash
npm run preview:ui        # or: node test/preview-ui.js
```

This renders the sidebar (workspace idle / workspace active / settings) and the
run-results panel to `test/preview/*.html` using the real HTML generators from
`src/ui/`. Open `test/preview/index.html` in any browser — iterate on the CSS in
`src/ui/sidebar.js` / `src/ui/resultPanel.js`, rerun the script, refresh the tab.
No "Reload Window" needed.

## 2. Run the extension against a clean test workspace

From the repo root press **F5** ("Run Extension (test workspace)"). This opens an
Extension Development Host window with the `test/` folder loaded and
`openPyFilesAsNotebook` enabled, so `sample-notebook.py` opens straight into the
Databricks notebook view.

- `sample-notebook.py` — widgets, plain Python cells, `%sql`
- `run-includes-notebook.py` — `%run ./_shared` expansion test
- `test/.vscode/settings.json` — settings applied only in the test workspace

**What needs a reload:** changes to the extension's JavaScript (`src/**/*.js`)
only take effect after the Extension Development Host reloads — press
**Ctrl+R** in that window, or stop and re-run F5. Changes to `src/python/*.py`
templates are re-read on the next run (session restart recommended: run
"Databricks Cell Runner: Restart Databricks Notebook Session").
