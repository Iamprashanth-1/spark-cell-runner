// Renders UI previews (configuration tree outline + results panel) to standalone
// HTML files in test/preview/ so you can iterate on the UI in a browser with NO
// extension-host reload.
//
// Usage:
//   node test/preview-ui.js
//   npm run preview:ui
//
// Then open test/preview/index.html (or any generated file) in a browser, or run
// "Simple Browser: Show" in VS Code and point it at a local server serving the
// folder (e.g. `npx serve test/preview`).

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(__dirname, 'preview');
fs.mkdirSync(outDir, { recursive: true });

// --- Minimal vscode stub so the UI modules can be required outside VS Code ---
const settings = {
  pythonCommand: 'C:/envs/databricks/Scripts/python.exe',
  tempFolder: '.spark-cell-runner',
  injectDatabricksBootstrap: true,
  databricksProfile: 'DEV',
  clusterId: '1001-223344-abcd12',
  useServerless: false,
  workspacePathMappings: {},
  secretValues: {},
  widgetValues: { env: 'prod' },
  openPyFilesAsNotebook: true,
};

const SAMPLE_WIDGET_SOURCE = [
  'dbutils.widgets.text("env", "dev", "Environment")',
  'dbutils.widgets.dropdown("region", "eu", ["eu", "us", "ap"], "Region")',
  'dbutils.widgets.multiselect("markets", "US", ["US", "EU", "APAC"], "Markets")',
].join('\n');

const activeNotebookEditor = {
  notebook: {
    uri: { fsPath: 'C:/work/test/sample-notebook.py', path: 'C:/work/test/sample-notebook.py', scheme: 'file', toString() { return this.fsPath; } },
    getCells() {
      return SAMPLE_WIDGET_SOURCE.split('\n').map((text) => ({
        document: { getText: () => text },
      }));
    },
  },
};

const activeTextEditor = {
  document: {
    uri: { fsPath: 'C:/work/test/sample-notebook.py', path: 'C:/work/test/sample-notebook.py', scheme: 'file', toString() { return this.fsPath; } },
  },
};

function makeVscodeStub({ notebookActive }) {
  return {
    workspace: {
      getConfiguration() {
        return {
          get(key, defaultValue) {
            const value = settings[key];
            return value === undefined ? defaultValue : value;
          },
          update: async () => {},
        };
      },
      asRelativePath(uri) {
        return 'test/sample-notebook.py';
      },
      workspaceFolders: [{ uri: { fsPath: 'C:/work' } }],
    },
    window: {
      activeNotebookEditor: notebookActive ? activeNotebookEditor : undefined,
      activeTextEditor: notebookActive ? activeTextEditor : undefined,
    },
  };
}

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};

// --- 1. Configuration tree outline (real provider, stubbed vscode) ----------
{
  const stub = makeVscodeStub({ notebookActive: true });
  require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub };
  Object.keys(require.cache)
    .filter((name) => name.includes(path.join(root, 'src')))
    .forEach((name) => delete require.cache[name]);

  const vscode = require('vscode');
  vscode.NotebookCellKind = { Markup: 1, Code: 2 };
  vscode.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
  vscode.ThemeIcon = class { constructor(id) { this.id = id; } };
  vscode.TreeItem = class { constructor(label, state) { this.label = label; this.collapsibleState = state; } };
  vscode.ThemeColor = class { constructor(id) { this.id = id; } };
  vscode.EventEmitter = class { constructor() { this.event = () => {}; } fire() {} };
  vscode.window.tabGroups = { all: [] };

  const { ConfigurationTreeProvider } = require(path.join(root, 'src', 'ui', 'configurationTree.js'));
  const provider = new ConfigurationTreeProvider();

  provider.getChildren().then((rows) => {
    const escape = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const render = (items, depth) => items.map((item) => {
      const icon = item.iconPath && item.iconPath.id ? '$' + item.iconPath.id : '';
      const children = item.children ? render(item.children, depth + 1) : '';
      return '<li style="margin:4px 0 0 ' + depth * 22 + 'px">'
        + '<code>' + escape(icon || ' ') + '</code> <strong>' + escape(item.label) + '</strong>'
        + (item.description !== undefined ? ' <span style="color:#888">' + escape(item.description) + '</span>' : '')
        + (item.command ? ' <span style="color:#5af">&rarr; ' + escape(item.command.command) + '</span>' : '')
        + children + '</li>';
    }).join('');

    fs.writeFileSync(
      path.join(outDir, 'configuration-tree.html'),
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Configuration tree preview</title></head>'
      + '<body style="font-family:sans-serif;max-width:720px;margin:30px auto;padding:0 16px">'
      + '<h2>Configuration panel (tree rows as the provider builds them)</h2>'
      + '<ul style="list-style:none;padding:0">' + render(rows, 0) + '</ul>'
      + '<p>Regenerated by <code>npm run preview:ui</code> &mdash; reflects the real row logic.</p></body></html>',
      'utf8'
    );
  });
}

// --- 2. Results panel --------------------------------------------------------
{
  const stub = makeVscodeStub({ notebookActive: true });
  require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub };
  Object.keys(require.cache)
    .filter((name) => name.includes(path.join(root, 'src')))
    .forEach((name) => delete require.cache[name]);
  const resultPanel = require(path.join(root, 'src', 'ui', 'resultPanel.js'));

  const payload = {
    built: {
      label: 'Databricks cell 4',
      script: '# Generated by Databricks Cell Runner from sample-notebook.py\n\ntry:\n    # Cell 4\n    print(f"x = {x}")\n\nexcept DCRNotebookExit as __dcr_notebook_exit:\n',
    },
    result: {
      exitCode: 1,
      stdout: 'x = 42\n',
      stderr: 'Traceback (most recent call last):\n  File "<string>", line 4, in <module>\nNameError: name \'y\' is not defined\n',
    },
    resultText: 'Label: Databricks cell 4\nScript: .spark-cell-runner/sample-notebook.cell-4.py\nExit Code: 1\n\nSTDOUT\nx = 42\n\nSTDERR\nNameError: name \'y\' is not defined\n',
    resultPath: '.spark-cell-runner/sample-notebook.cell-4.result.txt',
    scriptPath: '.spark-cell-runner/sample-notebook.cell-4.py',
  };

  fs.writeFileSync(path.join(outDir, 'result-panel.html'), resultPanel.getRunResultHtml(payload), 'utf8');
}

// --- index.html linking everything ------------------------------------------
fs.writeFileSync(path.join(outDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Databricks Cell Runner — UI previews</title>
<style>
  body { font-family: sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
  li { margin: 8px 0; }
  code { background: #eee; padding: 2px 5px; border-radius: 4px; }
</style></head>
<body>
<h1>Databricks Cell Runner — UI previews</h1>
<p>Regenerate with <code>npm run preview:ui</code>. Open in a browser; no extension reload needed.</p>
<ul>
  <li><a href="configuration-tree.html">Configuration panel — tree rows (real provider output)</a></li>
  <li><a href="result-panel.html">Run results panel (failure example)</a></li>
</ul>
<p>Note: in a plain browser the CSS variables fall back to defaults, so colors differ
slightly from VS Code's themed sidebar.</p>
</body></html>`, 'utf8');

console.log('UI previews written to test/preview/:');
for (const file of fs.readdirSync(outDir).sort()) {
  console.log('  ' + path.join('test', 'preview', file));
}
