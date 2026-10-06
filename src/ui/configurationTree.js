// Configuration panel — a native TreeView modelled on the official Databricks
// VS Code extension: every setting is a row (label = setting name, description
// = current value), state rows carry a ThemeIcon, and clicking a row opens a
// QuickPick flow instead of an inline form. Components below mirror
// databricks-vscode's ui/configuration-view components:
//   ConnectionComponent   — databricks vs. local-pool mode
//   ProfileComponent      — databricks profile (databricks mode)
//   ClusterComponent      — cluster / serverless (databricks mode)
//   PoolComponent         — local Sail pool lifecycle (local mode)
//   PythonEnvComponent    — interpreter
//   SyncComponent         — Unity Catalog -> pool sync
//   LakehouseComponent    — Docker/Podman container stack
//   WidgetsComponent      — dbutils.widgets values for the active notebook
//   SessionComponent      — notebook session recycling
//   EditorComponent       — open .py as notebook toggle

const vscode = require('vscode');
const poolManager = require('../poolManager');
const containerManager = require('../containerManager');
const { getConfiguration } = require('../config');
const state = require('../state');

const NOTEBOOK_TYPE = 'databricks-notebook-source';

class ConfigurationTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren(element) {
    if (element && element.children) {
      return element.children;
    }
    if (element) {
      return [];
    }

    const configuration = getConfiguration();
    const isLocal = configuration.connectionMode === 'local';
    const pools = poolManager.listPools();
    const activePool = pools.find((pool) => pool.name === configuration.localPool) || pools[0];
    const containerStatus = containerManager.getCachedStackStatus();
    const widgets = extractWidgetsFromActiveContext(configuration.widgetValues || {});
    const lastSync = state.lastSyncResult;

    const rows = [];

    // ---- Connection (mode switch) ----
    rows.push(row({
      label: 'Connection',
      description: isLocal
        ? `Local pool • ${activePool ? activePool.name : 'none'}`
        : `Databricks • ${configuration.useServerless ? 'serverless' : configuration.clusterId || 'no cluster'}`,
      icon: 'plug',
      command: { command: 'sparkCellRunner.setConnectionMode', title: 'Set Connection Mode' },
      tooltip: 'Switch between Databricks Connect and a local Spark pool',
    }));

    if (isLocal) {
      // ---- Local pool component ----
      const poolRow = row({
        label: 'Spark Pool',
        description: activePool
          ? `${activePool.name} — ${activePool.running ? `running on :${activePool.port}` : 'stopped'}`
          : 'No pools yet',
        icon: activePool && activePool.running
          ? new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('debugIcon.startForeground'))
          : activePool
            ? new vscode.ThemeIcon('circle-slash')
            : new vscode.ThemeIcon('plus'),
        command: { command: 'sparkCellRunner.poolMenu', title: 'Manage Local Spark Pool' },
        tooltip: activePool
          ? `Engine: ${activePool.engine}\nWarehouse: ${activePool.warehousePath}`
          : 'Create a pool to run Spark fully offline',
      });
      rows.push(poolRow);

      // ---- Unity Catalog sync component ----
      rows.push(row({
        label: 'Unity Catalog Sync',
        description: lastSync
          ? lastSync.running
            ? 'Syncing...'
            : (lastSync.ok ? '✓ ' : '⚠ ') + (lastSync.summary || 'finished')
          : 'Not synced yet',
        icon: 'cloud-download',
        command: { command: 'sparkCellRunner.syncMenu', title: 'Unity Catalog Sync' },
        tooltip: 'Mirror dev Unity Catalog schemas/tables into the local warehouse',
      }));
    } else {
      // ---- Profile + cluster components (databricks mode) ----
      rows.push(row({
        label: 'Databricks Profile',
        description: configuration.databricksProfile || 'Not set',
        icon: 'account',
        command: { command: 'sparkCellRunner.setDatabricksProfile', title: 'Set Databricks Profile' },
        tooltip: 'Profile from ~/.databrickscfg used for authentication',
      }));

      const serverless = Boolean(configuration.useServerless);
      rows.push(row({
        label: 'Cluster',
        description: serverless ? 'Serverless' : (configuration.clusterId || 'Not set'),
        icon: serverless
          ? new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('debugIcon.startForeground'))
          : 'server',
        command: { command: 'sparkCellRunner.setClusterId', title: 'Set Databricks Cluster ID' },
        tooltip: 'Cluster used for Databricks Connect runs',
      }));
    }

    // ---- Python environment ----
    rows.push(row({
      label: 'Python Environment',
      description: normalizeValue(configuration.pythonCommand),
      icon: 'terminal',
      command: { command: 'sparkCellRunner.selectPythonEnvironment', title: 'Select Python Environment' },
      tooltip: isLocal
        ? 'Notebook sessions run in the pool environment; this setting matters for Databricks mode and sync'
        : 'Interpreter with databricks-connect installed',
    }));

    // ---- Lakehouse container ----
    rows.push(row({
      label: 'Lakehouse Container',
      description: containerStatus && containerStatus.running
        ? `Running on :${containerStatus.port || containerManager.UI_PORT}`
        : 'Stopped',
      icon: containerStatus && containerStatus.running
        ? new vscode.ThemeIcon('server', new vscode.ThemeColor('debugIcon.startForeground'))
        : 'server',
      command: { command: 'sparkCellRunner.containerMenu', title: 'Lakehouse Container' },
      tooltip: 'Browse the pool warehouse from Docker/Podman Desktop',
    }));

    // ---- Widgets component (collapsible, Databricks-style children) ----
    rows.push(collapsible(
      'Notebook Widgets',
      widgets.length ? `${widgets.length} defined` : 'none in active notebook',
      'window',
      widgets.map((widget) => row({
        label: widget.label || widget.name,
        description: `${widget.type} • ${widget.value || '(empty)'}`,
        command: { command: 'sparkCellRunner.editWidget', title: 'Edit Widget Value', arguments: [widget.name, widget.type, widget.choices] },
      }))
    ));

    // ---- Session component ----
    const sessionNotebook = vscode.window.activeNotebookEditor
      ? vscode.workspace.asRelativePath(vscode.window.activeNotebookEditor.notebook.uri)
      : undefined;
    rows.push(row({
      label: 'Notebook Session',
      description: sessionNotebook ? `restarting recycles ${sessionNotebook}` : 'no active notebook',
      icon: 'debug-restart',
      command: { command: 'sparkCellRunner.restartNotebookSession', title: 'Restart Notebook Session' },
      tooltip: 'The persistent Python process keeps state across cells; restart to reset it',
    }));

    // ---- Editor behavior ----
    const openAsNotebook = Boolean(vscode.workspace.getConfiguration('sparkCellRunner').get('openPyFilesAsNotebook'));
    rows.push(row({
      label: 'Open .py as Notebook',
      description: openAsNotebook ? 'Enabled' : 'Disabled',
      icon: openAsNotebook ? 'check' : 'circle-large-outline',
      command: { command: 'sparkCellRunner.toggleOpenPyAsNotebook', title: 'Toggle Open .py as Notebook' },
      tooltip: 'When enabled, .py files open in the Databricks notebook view by default',
    }));

    return rows;
  }
}

function row({ label, description, icon, command, tooltip, children }) {
  const item = new vscode.TreeItem(label, children
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None);

  if (description !== undefined) {
    item.description = String(description);
  }
  if (icon) {
    item.iconPath = typeof icon === 'string' ? new vscode.ThemeIcon(icon) : icon;
  }
  if (command) {
    item.command = command;
  }
  if (tooltip) {
    item.tooltip = tooltip;
  }
  if (children) {
    item.children = children;
  }
  item.contextValue = 'sparkCellRunner.configuration.row';
  return item;
}

function collapsible(label, description, icon, children) {
  return row({ label, description, icon, children });
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

// --- Widget parsing (same grammar as the old sidebar webview) ---

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
  for (const line of source.split(/\r?\n/)) {
    const widget = parseWidgetDefinition(line, widgetValues);
    if (widget) {
      widgets.push(widget);
    }
  }

  const seen = new Map();
  for (const widget of widgets) {
    seen.set(widget.name, widget);
  }
  return [...seen.values()];
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
  const storedValue = widgetValues && Object.prototype.hasOwnProperty.call(widgetValues, name)
    ? widgetValues[name]
    : undefined;

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

function registerConfigurationTree(context) {
  const provider = new ConfigurationTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sparkCellRunner.configurationView', provider),
    // Keep the tree in sync with everything that used to refresh the webview.
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.window.onDidChangeActiveNotebookEditor(() => provider.refresh()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && event.document === activeEditor.document) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sparkCellRunner')) {
        provider.refresh();
      }
    }),
  );

  // Same handle shape the commands layer already uses for refreshes.
  return { refresh: () => provider.refresh() };
}

module.exports = {
  registerConfigurationTree,
  ConfigurationTreeProvider,
};
