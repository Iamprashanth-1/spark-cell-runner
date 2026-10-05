// Activity-bar sidebar UI for Spark Cell Runner.
//
// The whole panel is generated HTML (re-rendered on every message, matching
// the original architecture) but organised as self-contained *sections* that
// can be composed differently per view:
//   connection  — Databricks <-> local pool mode, pool lifecycle
//   sync        — Unity Catalog -> local pool sync form + last result
//   lakehouse   — Docker/Podman container stack over the pool warehouse
//   widgets     — dbutils.widgets form for the active notebook
//   actions     — notebook run actions + session tools
//   pythonEnv   — interpreter selection (settings view)
//   databricks  — profile/cluster/serverless (settings view)
//   editor      — open .py as notebook (settings view)
//
// Buttons carry their arguments via data-arg-* attributes; the webview script
// forwards them verbatim to handleSidebarMessage.

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const poolManager = require('../poolManager');
const containerManager = require('../containerManager');
const { syncPyEditorAssociation, reopenActivePyForCurrentMode } = require('../navigation');
const state = require('../state');

const WORKSPACE_VIEW_ID = 'sparkCellRunner.workspaceView';
const SETTINGS_VIEW_ID = 'sparkCellRunner.settingsView';

// Marketplace icon embedded as a data URI — webviews cannot load workspace
// files without a webview URI, and the icon is tiny enough to inline.
let logoDataUri;
function getLogoDataUri() {
  if (logoDataUri === undefined) {
    try {
      logoDataUri = `data:image/png;base64,${fs
        .readFileSync(path.join(__dirname, '..', '..', 'media', 'icon.png'))
        .toString('base64')}`;
    } catch {
      logoDataUri = '';
    }
  }
  return logoDataUri;
}

function registerDatabricksSidebar(context) {
  const workspaceProvider = new DatabricksSidebarViewProvider('workspace');
  const settingsProvider = new DatabricksSidebarViewProvider('settings');

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WORKSPACE_VIEW_ID, workspaceProvider),
    vscode.window.registerWebviewViewProvider(SETTINGS_VIEW_ID, settingsProvider),
  );

  return {
    refresh() {
      workspaceProvider.refresh();
      settingsProvider.refresh();
    },
  };
}

class DatabricksSidebarViewProvider {
  constructor(kind) {
    this.kind = kind;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await handleSidebarMessage(message);
      this.refresh();
    });
    void containerManager.detectRuntime();
    this.refresh();
  }

  refresh() {
    if (!this.view) {
      return;
    }

    this.view.webview.html = getSidebarHtml(this.kind);
  }
}

async function handleSidebarMessage(message) {
  switch (message.command) {
    // ----- direct settings -----
    case 'refresh':
      void containerManager.detectRuntime();
      return;
    case 'saveWidgetValues':
      await updateWorkspaceConfiguration('widgetValues', message.values || {});
      return;
    case 'saveSyncSettings':
      await saveSyncSettings(message.values || {});
      return;
    case 'setConnectionMode':
      await vscode.commands.executeCommand('sparkCellRunner.setConnectionMode', message.mode);
      return;
    case 'toggleOpenPyAsNotebook': {
      const current = Boolean(vscode.workspace.getConfiguration('sparkCellRunner').get('openPyFilesAsNotebook'));
      const next = !current;
      await updateWorkspaceConfiguration('openPyFilesAsNotebook', next);
      // Apply immediately (association + reopen the active file) instead of
      // only relying on the configuration-change listener.
      await syncPyEditorAssociation();
      await reopenActivePyForCurrentMode();
      void vscode.window.showInformationMessage(
        next
          ? 'Python files will now open as Databricks notebooks (workbench.editorAssociations updated).'
          : 'Python files will now open as plain text (workbench.editorAssociations updated).'
      );
      return;
    }

    // ----- local pools -----
    case 'createLocalPool':
    case 'installPoolPackages':
      await vscode.commands.executeCommand(
        message.command === 'createLocalPool'
          ? 'sparkCellRunner.createLocalPool'
          : 'sparkCellRunner.installLocalPoolPackages'
      );
      return;
    case 'startPool':
    case 'stopPool':
    case 'showPoolLogs':
    case 'deletePool':
    case 'useLocalPool': {
      const commandMap = {
        startPool: 'sparkCellRunner.startLocalPool',
        stopPool: 'sparkCellRunner.stopLocalPool',
        showPoolLogs: 'sparkCellRunner.showPoolLogs',
        deletePool: 'sparkCellRunner.deleteLocalPool',
      };
      if (message.command === 'useLocalPool') {
        await updateWorkspaceConfiguration('localPool', message.pool || '');
        await updateWorkspaceConfiguration('connectionMode', 'local');
        return;
      }
      await vscode.commands.executeCommand(commandMap[message.command], message.pool);
      return;
    }

    // ----- unity catalog sync -----
    case 'runUnityCatalogSync':
      if (message.values) {
        await saveSyncSettings(message.values);
      }
      await vscode.commands.executeCommand('sparkCellRunner.syncUnityCatalog');
      return;

    // ----- lakehouse container -----
    case 'launchLakehouse':
      await vscode.commands.executeCommand('sparkCellRunner.launchLakehouseContainer');
      return;
    case 'stopLakehouse':
      await vscode.commands.executeCommand('sparkCellRunner.stopLakehouseContainer');
      return;
    case 'openLakehouseConsole':
      await vscode.commands.executeCommand('sparkCellRunner.openLakehouseConsole');
      return;

    // ----- notebook actions -----
    case 'openAsNotebook':
      await vscode.commands.executeCommand('sparkCellRunner.openAsNotebook');
      return;
    case 'runCurrentCell':
      await vscode.commands.executeCommand('sparkCellRunner.runCurrentCell');
      return;
    case 'runAllCells':
      await vscode.commands.executeCommand('sparkCellRunner.runAllCells');
      return;
    case 'previewCurrentCell':
      await vscode.commands.executeCommand('sparkCellRunner.previewCurrentCell');
      return;
    case 'restartNotebookSession':
      await vscode.commands.executeCommand('sparkCellRunner.restartNotebookSession');
      return;
    case 'insertSqlFilterTemplate':
      await vscode.commands.executeCommand('sparkCellRunner.insertSqlFilterTemplate');
      return;

    // ----- settings -----
    case 'useActivePythonInterpreter':
      await vscode.commands.executeCommand('sparkCellRunner.useActivePythonInterpreter');
      return;
    case 'selectPythonEnvironment':
      await vscode.commands.executeCommand('sparkCellRunner.selectPythonEnvironment');
      return;
    case 'setPythonEnvironmentPath':
      await vscode.commands.executeCommand('sparkCellRunner.setPythonEnvironmentPath');
      return;
    case 'setClusterId':
      await vscode.commands.executeCommand('sparkCellRunner.setClusterId');
      return;
    case 'toggleServerlessMode':
      await vscode.commands.executeCommand('sparkCellRunner.toggleServerlessMode');
      return;
    case 'openSettings':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'sparkCellRunner');
      return;
    default:
      return;
  }
}

async function saveSyncSettings(values) {
  const mapping = {
    syncCatalog: 'syncCatalog',
    syncSchema: 'syncSchema',
    syncTables: 'syncTables',
    syncMode: 'syncMode',
    syncRowLimit: 'syncRowLimit',
  };

  for (const [field, setting] of Object.entries(mapping)) {
    if (field in values) {
      const value = field === 'syncRowLimit' ? Number(values[field]) || 0 : values[field];
      await updateWorkspaceConfiguration(setting, value);
    }
  }
}

// ---------------------------------------------------------------- rendering

function getSidebarHtml(kind) {
  const state = getSidebarState();
  const isWorkspace = kind === 'workspace';
  const title = isWorkspace ? 'Spark Cell Runner' : 'Runner settings';
  const subtitle = isWorkspace
    ? 'Run Databricks notebooks locally — against the cloud or a local Spark pool.'
    : 'Environments, connection, and editor behavior.';

  const sections = isWorkspace
    ? [
        renderConnectionSection(state),
        renderLakehouseSection(state),
        renderSyncSection(state),
        renderWidgetsSection(state),
        renderNotebookActionsSection(state),
        renderSessionToolsSection(state),
      ]
    : [
        renderPythonEnvSection(state),
        renderDatabricksSection(state),
        renderConnectionSection(state),
        renderEditorSection(state),
      ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>${getStyles()}</style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-head">
        <div class="hero-id">
          ${getLogoDataUri() ? `<img class="logo" src="${getLogoDataUri()}" alt="" />` : ''}
          <h1>${escapeHtml(title)}</h1>
        </div>
        <button class="refresh-btn" data-command="refresh" title="Refresh this panel">&#8635;</button>
      </div>
      <p>${escapeHtml(subtitle)}</p>
      <div class="status${state.heroReady ? ' ready' : ''}"><span class="dot"></span>${escapeHtml(state.heroText)}</div>
    </section>
    ${sections.join('\n')}
      <div class="footer">Spark Cell Runner v0.3.4</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    function collectFields(selector, attribute) {
      const values = {};
      document.querySelectorAll(selector).forEach((field) => {
        const key = field.getAttribute(attribute);
        if (key) {
          values[key] = field.value;
        }
      });
      return values;
    }

    document.querySelectorAll('[data-command]').forEach((element) => {
      element.addEventListener('click', () => {
        const payload = { command: element.dataset.command };

        for (const [key, value] of Object.entries(element.dataset)) {
          if (key.startsWith('arg') && key !== 'arg') {
            payload[key.slice(3).toLowerCase()] = value;
          }
        }

        if (element.dataset.command === 'saveWidgetValues') {
          payload.values = collectFields('[data-widget-name]', 'data-widget-name');
        }

        if (
          element.dataset.command === 'saveSyncSettings' ||
          element.dataset.command === 'runUnityCatalogSync'
        ) {
          payload.values = collectFields('[data-sync-field]', 'data-sync-field');
        }

        vscode.postMessage(payload);
      });
    });
  </script>
</body>
</html>`;
}

// ------------------------------------------------------------------- state

function getSidebarState() {
  const configuration = vscode.workspace.getConfiguration('sparkCellRunner');
  const activeNotebookEditor = vscode.window.activeNotebookEditor;
  const connectionMode = configuration.get('connectionMode', 'databricks') === 'local' ? 'local' : 'databricks';
  const localPoolName = configuration.get('localPool', '');
  const pools = poolManager.listPools();
  const activePool = pools.find((pool) => pool.name === localPoolName) || pools[0];
  const containerRuntime = containerManager.getCachedRuntime();
  const containerStatus = containerManager.getCachedStackStatus();
  const lastSync = state.lastSyncResult;

  let heroText;
  let heroReady = false;

  if (connectionMode === 'local') {
    const poolStatus = activePool ? (activePool.running ? 'running' : 'stopped') : 'no pool';
    heroText = `Local pool • ${activePool ? activePool.name : 'none'} (${poolStatus})`;
    heroReady = Boolean(activePool && activePool.running);
  } else {
    const serverless = Boolean(configuration.get('useServerless'));
    const clusterId = (configuration.get('clusterId') || '').trim();
    heroText = `Databricks • ${serverless ? 'serverless' : clusterId || 'no cluster set'}`;
    heroReady = serverless || Boolean(clusterId);
  }

  return {
    heroText,
    heroReady,
    connectionMode,
    localPool: localPoolName || (activePool ? activePool.name : ''),
    activePool,
    pools,
    containerRuntime,
    containerRunning: Boolean(containerStatus && containerStatus.running),
    lastSync,
    pythonCommand: normalizeValue(configuration.get('pythonCommand')),
    tempFolder: normalizeValue(configuration.get('tempFolder')),
    profile: normalizeValue(configuration.get('databricksProfile')),
    clusterId: normalizeValue(configuration.get('clusterId')),
    serverless: Boolean(configuration.get('useServerless')),
    openPyAsNotebook: Boolean(configuration.get('openPyFilesAsNotebook')),
    sync: {
      catalog: configuration.get('syncCatalog', ''),
      schema: configuration.get('syncSchema', ''),
      tables: configuration.get('syncTables', ''),
      mode: configuration.get('syncMode', 'schema'),
      rowLimit: configuration.get('syncRowLimit', 0),
    },
    widgets: extractWidgetsFromActiveContext(configuration.get('widgetValues', {})),
    activeFile: vscode.window.activeTextEditor
      ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri)
      : 'No active text editor',
    activeNotebook: activeNotebookEditor
      ? vscode.workspace.asRelativePath(activeNotebookEditor.notebook.uri)
      : 'No active notebook',
  };
}

// ----------------------------------------------------------------- sections

function section(id, title, description, body, open = true) {
  return `
  <details class="card" ${open ? 'open' : ''}>
    <summary><span class="section-tag">${escapeHtml(title)}</span><span class="chevron">&#9662;</span></summary>
    <p class="desc">${escapeHtml(description)}</p>
    ${body}
  </details>`;
}

function metaRows(rows) {
  const html = rows
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `<div class="meta-row"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span></div>`)
    .join('');
  return html ? `<div class="meta">${html}</div>` : '';
}

function buttons(defs) {
  const html = defs
    .map((def) => {
      const [label, command, options] = def;
      const opts = options || {};
      const attrs = Object.entries(opts.args || {})
        .map(([key, value]) => ` data-arg-${key}="${escapeHtml(value)}"`)
        .join('');
      return `<button class="action${opts.secondary ? ' secondary' : ''}${opts.danger ? ' danger' : ''}" data-command="${escapeHtml(command)}"${attrs}>${escapeHtml(label)}</button>`;
    })
    .join('');
  return `<div class="actions">${html}</div>`;
}

function statusDot(ok, label) {
  return `<span class="badge${ok ? ' ok' : ''}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

function renderConnectionSection(state) {
  const segmented = `
    <div class="segment">
      <button class="segment-btn${state.connectionMode === 'databricks' ? ' active' : ''}" data-command="setConnectionMode" data-arg-mode="databricks">Databricks</button>
      <button class="segment-btn${state.connectionMode === 'local' ? ' active' : ''}" data-command="setConnectionMode" data-arg-mode="local">Local pool</button>
    </div>`;

  let body = segmented;

  if (state.connectionMode === 'local') {
    const pool = state.activePool;

    if (pool) {
      const others = state.pools
        .filter((entry) => entry.name !== pool.name)
        .map((entry) => `
          <div class="pool-row meta-row">
            <span class="k">${entry.running ? 'Running' : 'Stopped'}</span>
            <span class="v">${escapeHtml(entry.name)}
              <button class="mini-btn" data-command="useLocalPool" data-arg-pool="${escapeHtml(entry.name)}">Use</button>
            </span>
          </div>`)
        .join('');

      body += `
        ${metaRows([
          ['Pool', pool.name],
          ['Engine', pool.engine],
          ['Port', pool.port],
          ['Warehouse', pool.warehousePath],
        ])}
        <div class="statusline">${statusDot(pool.running, pool.running ? 'Running' : 'Stopped')}</div>
        ${others ? `<div class="meta">${others}</div>` : ''}
        ${buttons([
          [pool.running ? `Stop "${pool.name}"` : `Start "${pool.name}"`, pool.running ? 'stopPool' : 'startPool', { args: { pool: pool.name } }],
          ['Pool logs', 'showPoolLogs', { secondary: true, args: { pool: pool.name } }],
          ['New pool...', 'createLocalPool'],
          ['Install Sail packages', 'installPoolPackages', { secondary: true }],
          ['Delete pool', 'deletePool', { secondary: true, danger: true, args: { pool: pool.name } }],
        ])}`;
    } else {
      body += `
        <div class="statusline">${statusDot(false, 'No pools yet')}</div>
        ${buttons([
          ['Create a local pool', 'createLocalPool'],
          ['Install Sail packages', 'installPoolPackages', { secondary: true }],
        ])}`;
    }

    return section(
      'connection',
      'Connection',
      'Local pools run a Sail Spark Connect server on your machine — no cloud needed.',
      body
    );
  }

  body += `
    ${metaRows([
      ['Profile', state.profile],
      ['Cluster', state.clusterId],
      ['Serverless', state.serverless ? 'Enabled' : 'Disabled'],
    ])}
    ${buttons([
      ['Set cluster ID', 'setClusterId'],
      ['Toggle serverless mode', 'toggleServerlessMode', { secondary: true }],
      ['Create a local pool instead', 'createLocalPool', { secondary: true }],
    ])}`;

  return section(
    'connection',
    'Connection',
    'Runs go through Databricks Connect (serverless or a cluster).',
    body
  );
}

function renderSyncSection(state) {
  if (state.connectionMode !== 'local') {
    return section(
      'sync',
      'Unity Catalog sync',
      'Switch the connection to a local pool to sync Unity Catalog schemas and tables for offline development.',
      '',
      false
    );
  }

  const last = state.lastSync;
  const lastResult = last
    ? `<div class="statusline">${statusDot(Boolean(last.ok && !last.running), last.running ? 'Sync running...' : last.ok ? 'Last sync OK' : 'Last sync failed')}
       <div class="sync-summary">${escapeHtml(last.running ? (last.summary || 'Starting...') : last.summary || '')}</div></div>`
    : '';

  const fields = `
    <div class="form">
      <label class="field"><span>Catalog</span>
        <input data-sync-field="syncCatalog" value="${escapeHtml(state.sync.catalog)}" placeholder="e.g. main (empty = all)" /></label>
      <label class="field"><span>Schema</span>
        <input data-sync-field="syncSchema" value="${escapeHtml(state.sync.schema)}" placeholder="e.g. sales (empty = all)" /></label>
      <label class="field"><span>Table pattern</span>
        <input data-sync-field="syncTables" value="${escapeHtml(state.sync.tables)}" placeholder="e.g. dim_* (empty = all)" /></label>
      <label class="field"><span>Mode</span>
        <select data-sync-field="syncMode">
          <option value="schema"${state.sync.mode === 'schema' ? ' selected' : ''}>Schema only (empty tables, fast)</option>
          <option value="data"${state.sync.mode === 'data' ? ' selected' : ''}>Schema + data (copies rows)</option>
        </select></label>
      <label class="field"><span>Row limit (data mode)</span>
        <input data-sync-field="syncRowLimit" type="number" min="0" value="${escapeHtml(String(state.sync.rowLimit || 0))}" /></label>
    </div>`;

  return section(
    'sync',
    'Unity Catalog sync',
    'Mirror dev Unity Catalog tables into the local warehouse: schema-only by default, optional row copy.',
    `${fields}${lastResult}
     ${buttons([
       ['Run sync', 'runUnityCatalogSync'],
       ['Save filters', 'saveSyncSettings', { secondary: true }],
     ])}`,
    false
  );
}

function renderLakehouseSection(state) {
  const runtime = state.containerRuntime;
  const runtimeLabel = runtime === 'docker'
    ? 'Docker detected'
    : runtime === 'podman'
      ? 'Podman detected'
      : runtime === undefined ? 'Detecting...' : 'No container runtime found';

  const body = `
    ${metaRows([
      ['Runtime', runtimeLabel],
      ['Stack', state.containerRunning ? 'Running' : 'Stopped'],
      ['Warehouse UI', `http://localhost:${containerManager.getCachedUiPort()}`],
    ])}
    <div class="statusline">${statusDot(state.containerRunning, state.containerRunning ? 'UI running' : 'Not running')}</div>
    ${buttons(runtime
      ? [
          state.containerRunning
            ? ['Stop container stack', 'stopLakehouse']
            : ['Launch container stack', 'launchLakehouse'],
          ['Open warehouse UI', 'openLakehouseConsole', { secondary: true }],
        ]
      : [['Retry detection', 'refresh', { secondary: true }]])}`;

  return section(
    'lakehouse',
    'Lakehouse container',
    'Expose the active pool warehouse to Docker/Podman Desktop as a browsable web UI over the Delta files.',
    body,
    false
  );
}

function renderWidgetsSection(state) {
  if (!state.widgets.length) {
    return section(
      'widgets',
      'Notebook widgets',
      'Open a notebook that defines dbutils.widgets to manage their values here.',
      metaRows([['Supported', 'text, dropdown, combobox, multiselect']]),
      false
    );
  }

  const rows = state.widgets.map((widget) => {
    const options = (widget.type === 'dropdown' || widget.type === 'combobox')
      ? widget.choices.map((choice) => `<option value="${escapeHtml(choice)}"${choice === widget.value ? ' selected' : ''}>${escapeHtml(choice)}</option>`).join('')
      : undefined;

    return `
    <label class="field">
      <span>${escapeHtml(widget.label || widget.name)} <small>${escapeHtml(widget.type)}</small></span>
      ${options !== undefined
        ? `<select data-widget-name="${escapeHtml(widget.name)}">${options}</select>`
        : `<input data-widget-name="${escapeHtml(widget.name)}" value="${escapeHtml(widget.value || '')}" />`}
    </label>`;
  }).join('');

  return section(
    'widgets',
    'Notebook widgets',
    'Values are passed into the local dbutils.widgets proxy when cells run.',
    `<div class="form">${rows}</div>
     ${buttons([['Save widget values', 'saveWidgetValues']])}`,
    false
  );
}

function renderNotebookActionsSection(state) {
  return section(
    'actions',
    'Notebook actions',
    'Open notebook-source files and run cells from a compact action panel.',
    `${metaRows([
      ['Active file', state.activeFile],
      ['Notebook', state.activeNotebook],
    ])}
     ${buttons([
       ['Open as notebook', 'openAsNotebook'],
       ['Run current cell', 'runCurrentCell'],
       ['Run all cells', 'runAllCells'],
       ['Preview generated script', 'previewCurrentCell', { secondary: true }],
     ])}`,
    false
  );
}

function renderSessionToolsSection(state) {
  return section(
    'session',
    'Session tools',
    'Execution helpers for the current notebook session.',
    buttons([
      ['Restart notebook session', 'restartNotebookSession'],
      ['Insert SQL filter template', 'insertSqlFilterTemplate', { secondary: true }],
    ]),
    false
  );
}

function renderPythonEnvSection(state) {
  return section(
    'python',
    'Python environment',
    'The interpreter used to run notebook sessions and local pools.',
    `${metaRows([
      ['Python', state.pythonCommand],
      ['Temp folder', state.tempFolder],
    ])}
     ${buttons([
       ['Use active VS Code interpreter', 'useActivePythonInterpreter'],
       ['Select Python environment', 'selectPythonEnvironment'],
       ['Set Python path', 'setPythonEnvironmentPath', { secondary: true }],
     ])}`
  );
}

function renderDatabricksSection(state) {
  return section(
    'databricks',
    'Databricks connection',
    'Cluster and serverless settings for Databricks Connect runs.',
    `${metaRows([
      ['Profile', state.profile],
      ['Cluster', state.clusterId],
      ['Serverless', state.serverless ? 'Enabled' : 'Disabled'],
    ])}
     ${buttons([
       ['Set cluster ID', 'setClusterId'],
       ['Toggle serverless mode', 'toggleServerlessMode', { secondary: true }],
       ['Open full extension settings', 'openSettings', { secondary: true }],
     ])}`,
    false
  );
}

function renderEditorSection(state) {
  return section(
    'editor',
    'Editor behavior',
    'Open .py files in the Databricks notebook view automatically, or leave them as plain text.',
    `${metaRows([['Open .py as notebook', state.openPyAsNotebook ? 'Enabled' : 'Disabled']])}
     ${buttons([[
       state.openPyAsNotebook ? 'Disable open .py as notebook' : 'Enable open .py as notebook',
       'toggleOpenPyAsNotebook',
     ]])}`,
    false
  );
}

// ------------------------------------------------------------------- styles

function getStyles() {
  return `
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --accent-fg: var(--vscode-button-foreground);
      --border: var(--vscode-widget-border);
      --card: color-mix(in srgb, var(--bg) 92%, var(--fg) 8%);
      --input: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --pill: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 40%, var(--bg) 60%);
      --ok: var(--vscode-terminal-ansiGreen, #3fb950);
      --danger: var(--vscode-terminal-ansiRed, #f85149);
      --idle: var(--vscode-descriptionForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 10px 10px 16px;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .shell { display: grid; gap: 10px; }
    .hero {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 14%, var(--card)), var(--card));
    }
    .hero-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .hero-id { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .logo { width: 22px; height: 22px; border-radius: 6px; flex: none; }
    .hero h1 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; }
    .hero p { margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .refresh-btn {
      flex: none; width: auto; padding: 3px 9px; border-radius: 6px;
      border: 1px solid var(--border); background: transparent; color: var(--fg);
      font: inherit; font-size: 11px; cursor: pointer;
    }
    .refresh-btn:hover { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .status {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 10px;
      padding: 3px 9px; border-radius: 999px; background: var(--pill);
      border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .status .dot, .badge .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--idle); }
    .status.ready .dot { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
    .status.ready { border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
    details.card {
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--card);
    }
    details.card summary {
      list-style: none;
      display: flex; align-items: center; justify-content: space-between;
      margin: 0 -12px; padding: 10px 12px; cursor: pointer; user-select: none;
    }
    details.card summary::-webkit-details-marker { display: none; }
    details.card[open] summary { border-bottom: 1px solid var(--border); }
    details.card > *:not(summary) { display: block; }
    details.card[open] { padding-bottom: 12px; }
    details.card[open] > p.desc, details.card[open] > .meta, details.card[open] > .form,
    details.card[open] > .actions, details.card[open] > .segment, details.card[open] > .statusline { margin-top: 10px; }
    .chevron { color: var(--muted); font-size: 10px; transition: transform 0.1s ease; }
    details[open] .chevron { transform: rotate(180deg); }
    .section-tag {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--fg); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .section-tag::before { content: ''; width: 8px; height: 8px; border-radius: 999px; background: var(--accent); }
    p.desc { margin: 0 0 2px; color: var(--muted); font-size: 11px; line-height: 1.4; }
    .meta {
      display: grid; gap: 4px; padding: 8px 9px;
      border: 1px solid var(--border); border-radius: 8px;
      background: color-mix(in srgb, var(--bg) 94%, var(--fg) 6%);
      font-size: 10.5px;
    }
    .meta-row { display: grid; grid-template-columns: 78px 1fr; gap: 8px; align-items: baseline; }
    .meta-row .k { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.04em; }
    .meta-row .v { word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
    .segment { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .segment-btn {
      padding: 7px 8px; border: 0; background: transparent; color: var(--muted);
      font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .segment-btn + .segment-btn { border-left: 1px solid var(--border); }
    .segment-btn.active { background: var(--accent); color: var(--accent-fg); }
    .segment-btn:not(.active):hover { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--fg); }
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 9px; border-radius: 999px; background: var(--pill);
      border: 1px solid var(--border); font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge.ok .dot { background: var(--ok); }
    .statusline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .sync-summary { color: var(--muted); font-size: 10.5px; width: 100%; }
    .form { display: grid; gap: 8px; }
    .field {
      display: grid; gap: 4px; padding: 8px;
      border: 1px solid var(--border); border-radius: 8px;
      background: color-mix(in srgb, var(--bg) 94%, var(--fg) 6%);
    }
    .field span { font-size: 11px; font-weight: 700; line-height: 1.2; }
    .field span small { color: var(--muted); font-weight: 400; margin-left: 4px; }
    .field input, .field select {
      width: 100%; min-width: 0; padding: 7px 8px; border-radius: 6px;
      border: 1px solid var(--input-border); background: var(--input);
      color: var(--fg); font: inherit; font-size: 11px; outline: none;
    }
    .field input:focus, .field select:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .actions { display: grid; gap: 6px; }
    button.action {
      width: 100%; border: 0; border-radius: 8px; padding: 8px 10px;
      background: var(--accent); color: var(--accent-fg);
      font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
      text-align: left; transition: filter 0.1s ease;
    }
    button.action:hover { background: var(--accent-hover); }
    button.action.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
    button.action.secondary:hover { border-color: var(--accent); color: var(--accent-fg); background: color-mix(in srgb, var(--accent) 12%, transparent); }
    button.action.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
    button.action.danger:hover { background: color-mix(in srgb, var(--danger) 15%, transparent); border-color: var(--danger); }
    .mini-btn {
      margin-left: 6px; padding: 2px 8px; border-radius: 5px;
      border: 1px solid var(--border); background: transparent; color: var(--fg);
      font: inherit; font-size: 9.5px; cursor: pointer;
    }
    .mini-btn:hover { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .pool-row .v { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .footer { margin-top: 2px; text-align: center; color: var(--muted); font-size: 9.5px; letter-spacing: 0.04em; }
  `;
}

// ------------------------------------------------------------------ helpers

function extractWidgetsFromActiveContext(widgetValues) {
  const notebookEditor = vscode.window.activeNotebookEditor;
  const textEditor = vscode.window.activeTextEditor;
  let source = '';

  if (notebookEditor) {
    source = notebookEditor.notebook.getCells().map((cell) => cell.document.getText()).join('\n');
  } else if (textEditor) {
    source = textEditor.document.getText();
  }

  if (!source) {
    return [];
  }

  const widgets = [];
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const widget = parseWidgetDefinition(line, widgetValues);
    if (widget) {
      widgets.push(widget);
    }
  }

  return dedupeWidgets(widgets);
}

function parseWidgetDefinition(line, widgetValues) {
  const match = line.match(/dbutils\.widgets\.(text|dropdown|combobox|multiselect)\s*\((.*)\)\s*$/);
  if (!match) {
    return undefined;
  }

  const type = match[1];
  const args = splitArguments(match[2]);
  if (!args.length) {
    return undefined;
  }

  const name = parsePythonString(args[0]);
  if (!name) {
    return undefined;
  }

  const defaultValue = args.length > 1 ? parsePythonValue(args[1]) : '';
  const choices = (type === 'dropdown' || type === 'combobox' || type === 'multiselect') && args.length > 2
    ? parsePythonList(args[2])
    : [];
  const label = args.length > 3 ? parsePythonString(args[3]) : name;
  const storedValue = widgetValues && Object.prototype.hasOwnProperty.call(widgetValues, name) ? widgetValues[name] : undefined;

  return {
    type,
    name,
    label,
    choices,
    value: normalizeWidgetValue(type, storedValue, defaultValue, choices),
  };
}

function normalizeWidgetValue(type, storedValue, defaultValue, choices) {
  if (storedValue !== undefined && storedValue !== null) {
    return Array.isArray(storedValue) ? storedValue.join(',') : String(storedValue);
  }

  if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
    return Array.isArray(defaultValue) ? defaultValue.join(',') : String(defaultValue);
  }

  if ((type === 'dropdown' || type === 'combobox') && choices.length) {
    return choices[0];
  }

  return '';
}

function dedupeWidgets(widgets) {
  const seen = new Map();
  for (const widget of widgets) {
    seen.set(widget.name, widget);
  }
  return [...seen.values()];
}

function splitArguments(argumentText) {
  const args = [];
  let current = '';
  let depth = 0;
  let quote = '';

  for (let index = 0; index < argumentText.length; index += 1) {
    const char = argumentText[index];
    const previous = index > 0 ? argumentText[index - 1] : '';

    if (quote) {
      current += char;
      if (char === quote && previous !== '\\') {
        quote = '';
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '[' || char === '(' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ']' || char === ')' || char === '}') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function parsePythonValue(rawValue) {
  const stringValue = parsePythonString(rawValue);
  if (stringValue !== undefined) {
    return stringValue;
  }

  const listValue = parsePythonList(rawValue);
  if (listValue.length || rawValue.trim() === '[]') {
    return listValue;
  }

  return rawValue.trim();
}

function parsePythonList(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return [];
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return splitArguments(inner)
    .map((item) => parsePythonString(item))
    .filter((item) => item !== undefined);
}

function parsePythonString(rawValue) {
  const trimmed = rawValue.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1).replace(/\\'/g, '\'').replace(/\\"/g, '"');
  }
  return undefined;
}

async function updateWorkspaceConfiguration(key, value) {
  await vscode.workspace.getConfiguration('sparkCellRunner').update(key, value, vscode.ConfigurationTarget.Workspace);
}

function normalizeValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || 'Not set';
  }

  if (value === undefined || value === null || value === '') {
    return 'Not set';
  }

  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  registerDatabricksSidebar,
  // Exported so test/preview-ui.js can render the sidebar HTML in a plain browser.
  getSidebarHtml,
  getSidebarState,
};
