const vscode = require('vscode');

const WORKSPACE_VIEW_ID = 'sparkCellRunner.workspaceView';
const SETTINGS_VIEW_ID = 'sparkCellRunner.settingsView';

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
    case 'refresh':
      // No-op: the provider refreshes after every message.
      return;
    case 'saveWidgetValues':
      await updateWorkspaceConfiguration('widgetValues', message.values || {});
      return;
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
    case 'toggleOpenPyAsNotebook': {
      const current = Boolean(vscode.workspace.getConfiguration('sparkCellRunner').get('openPyFilesAsNotebook'));
      const next = !current;
      await updateWorkspaceConfiguration('openPyFilesAsNotebook', next);
      if (next) {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.scheme === 'file' && editor.document.uri.fsPath.toLowerCase().endsWith('.py')) {
          await vscode.commands.executeCommand('sparkCellRunner.openAsNotebook', editor.document.uri);
        }
      }
      return;
    }
    case 'openSettings':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'sparkCellRunner');
      return;
    default:
      return;
  }
}

function getSidebarHtml(kind) {
  const state = getSidebarState();
  const isWorkspace = kind === 'workspace';
  const title = isWorkspace ? 'Spark Cell Runner' : 'Runner settings';
  const subtitle = isWorkspace
    ? 'Notebook widgets, quick actions, and local Databricks run controls.'
    : 'Common execution settings without opening the command palette.';
  const cards = isWorkspace ? getWorkspaceCards(state) : getSettingsCards(state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
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
    .hero-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .hero h1 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .hero p {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .refresh-btn {
      flex: none;
      width: auto;
      padding: 4px 9px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg);
      font: inherit;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .refresh-btn:hover {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--pill);
      border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .status .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--idle);
    }
    .status.ready .dot { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
    .status.ready { border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
    .card {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--card);
    }
    .card h2 {
      margin: 0 0 4px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card > p {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
    }
    .section-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .section-tag::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--accent);
    }
    .meta {
      display: grid;
      gap: 4px;
      margin: 0 0 10px;
      padding: 8px 9px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg) 94%, var(--fg) 6%);
      font-size: 10.5px;
    }
    .meta-row {
      display: grid;
      grid-template-columns: 78px 1fr;
      gap: 8px;
      align-items: baseline;
    }
    .meta-row .k {
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 9.5px;
      letter-spacing: 0.04em;
    }
    .meta-row .v {
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
    }
    .actions { display: grid; gap: 6px; }
    button.action {
      width: 100%;
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--accent);
      color: var(--accent-fg);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      transition: filter 0.1s ease;
    }
    button.action:hover { background: var(--accent-hover); }
    button.action.secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    button.action.secondary:hover {
      border-color: var(--accent);
      color: var(--accent-fg);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .widget-form { display: grid; gap: 8px; margin-bottom: 10px; }
    .widget-field {
      display: grid;
      gap: 4px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg) 94%, var(--fg) 6%);
    }
    .widget-field span { font-size: 11px; font-weight: 700; line-height: 1.2; }
    .widget-field small { color: var(--muted); font-size: 10px; line-height: 1.2; word-break: break-word; }
    .widget-field input,
    .widget-field select {
      width: 100%;
      min-width: 0;
      padding: 7px 8px;
      border-radius: 6px;
      border: 1px solid var(--input-border);
      background: var(--input);
      color: var(--fg);
      font: inherit;
      font-size: 11px;
      outline: none;
    }
    .widget-field input:focus,
    .widget-field select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .footer {
      margin-top: 2px;
      text-align: center;
      color: var(--muted);
      font-size: 9.5px;
      letter-spacing: 0.04em;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-head">
        <h1>${escapeHtml(title)}</h1>
        <button class="refresh-btn" data-command="refresh" title="Refresh this panel">&#8635; Refresh</button>
      </div>
      <p>${escapeHtml(subtitle)}</p>
      <div class="status${state.ready ? ' ready' : ''}"><span class="dot"></span>${escapeHtml(state.summary)}</div>
    </section>
    ${cards}
    <div class="footer">Spark Cell Runner v0.2.0</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.command === 'saveWidgetValues') {
          const values = {};
          document.querySelectorAll('[data-widget-name]').forEach((field) => {
            values[field.dataset.widgetName] = field.value;
          });
          vscode.postMessage({ command: button.dataset.command, values });
          return;
        }

        vscode.postMessage({ command: button.dataset.command });
      });
    });
  </script>
</body>
</html>`;
}

function getWorkspaceCards(state) {
  const widgetCard = createWidgetCard(state.widgets);
  return [
    widgetCard,
    createCard(
      'Notebook actions',
      'Open notebook-source files and run cells from a compact action panel.',
      [
        ['Active file', state.activeFile],
        ['Notebook', state.activeNotebook],
      ],
      [
        ['Open as notebook', 'openAsNotebook'],
        ['Run current cell', 'runCurrentCell'],
        ['Run all cells', 'runAllCells'],
        ['Preview generated script', 'previewCurrentCell'],
      ],
    ),
    createCard(
      'Session tools',
      'Execution helpers for the current local Databricks session.',
      [
        ['Cluster', state.clusterId],
        ['Serverless', state.serverless],
      ],
      [
        ['Restart notebook session', 'restartNotebookSession'],
        ['Insert SQL filter template', 'insertSqlFilterTemplate'],
      ],
    ),
  ].join('');
}

function getSettingsCards(state) {
  return [
    createCard(
      'Python environment',
      'Pick the Python environment used for Databricks Connect runs.',
      [
        ['Python', state.pythonCommand],
        ['Temp folder', state.tempFolder],
      ],
      [
        ['Use active VS Code interpreter', 'useActivePythonInterpreter'],
        ['Select Python environment', 'selectPythonEnvironment'],
        ['Set Python path', 'setPythonEnvironmentPath'],
      ],
    ),
    createCard(
      'Connection settings',
      'Manage the cluster or serverless mode directly from the sidebar.',
      [
        ['Profile', state.profile],
        ['Cluster', state.clusterId],
        ['Serverless', state.serverless],
      ],
      [
        ['Set cluster ID', 'setClusterId'],
        ['Toggle serverless mode', 'toggleServerlessMode'],
        ['Open full extension settings', 'openSettings', true],
      ],
    ),
    createCard(
      'Editor behavior',
      'Open .py files in the Databricks notebook view automatically, or leave them as plain text.',
      [
        ['Open .py as notebook', state.openPyAsNotebook],
      ],
      [
        [state.openPyAsNotebook === 'Enabled' ? 'Disable open .py as notebook' : 'Enable open .py as notebook', 'toggleOpenPyAsNotebook'],
      ],
    ),
  ].join('');
}

function createCard(title, description, metaRows, actions) {
  const metaHtml = metaRows
    .map(([key, value]) => `<div class="meta-row"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span></div>`)
    .join('');

  const buttons = actions.map(([label, command, secondary]) => (
    `<button class="action${secondary ? ' secondary' : ''}" data-command="${escapeHtml(command)}">${escapeHtml(label)}</button>`
  )).join('');

  return `
    <section class="card">
      <div class="section-tag">${escapeHtml(title)}</div>
      <p>${escapeHtml(description)}</p>
      <div class="meta">${metaHtml}</div>
      <div class="actions">${buttons}</div>
    </section>`;
}

function createWidgetCard(widgets) {
  if (!widgets.length) {
    return `
    <section class="card">
      <div class="section-tag">Widgets</div>
      <p>Open a Databricks notebook-source file that contains dbutils.widgets definitions to manage them here.</p>
      <div class="meta">
        <div class="meta-row"><span class="k">Supported</span><span class="v">text, dropdown, combobox, multiselect</span></div>
      </div>
    </section>`;
  }

  const rows = widgets.map((widget) => {
    const label = escapeHtml(widget.label || widget.name);
    const description = escapeHtml(`${widget.type} • ${widget.name}`);
    const value = escapeHtml(widget.value || '');
    if (widget.type === 'dropdown' || widget.type === 'combobox') {
      const options = widget.choices.map((choice) => {
        const escaped = escapeHtml(choice);
        const selected = choice === widget.value ? ' selected' : '';
        return `<option value="${escaped}"${selected}>${escaped}</option>`;
      }).join('');
      return `
      <label class="widget-field">
        <span>${label}</span>
        <small>${description}</small>
        <select data-widget-name="${escapeHtml(widget.name)}">${options}</select>
      </label>`;
    }

    return `
      <label class="widget-field">
        <span>${label}</span>
        <small>${description}</small>
        <input data-widget-name="${escapeHtml(widget.name)}" value="${value}" />
      </label>`;
  }).join('');

  return `
    <section class="card">
      <div class="section-tag">Widgets</div>
      <p>These values are passed into the local dbutils.widgets proxy when you run cells.</p>
      <div class="widget-form">${rows}</div>
      <div class="actions">
        <button class="action" data-command="saveWidgetValues">Save widget values</button>
      </div>
    </section>`;
}

function getSidebarState() {
  const configuration = vscode.workspace.getConfiguration('sparkCellRunner');
  const activeEditor = vscode.window.activeTextEditor;
  const activeNotebookEditor = vscode.window.activeNotebookEditor;
  const activeFile = activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri) : 'No active text editor';
  const activeNotebook = activeNotebookEditor ? vscode.workspace.asRelativePath(activeNotebookEditor.notebook.uri) : 'No active notebook';
  const clusterId = normalizeValue(configuration.get('clusterId'));
  const serverlessEnabled = Boolean(configuration.get('useServerless'));

  const summary = activeNotebookEditor
    ? 'Notebook session ready'
    : (activeEditor ? 'Python editor active' : 'Open a notebook-source file');

  return {
    summary,
    ready: activeNotebookEditor !== undefined,
    activeFile,
    activeNotebook,
    pythonCommand: normalizeValue(configuration.get('pythonCommand')),
    tempFolder: normalizeValue(configuration.get('tempFolder')),
    profile: normalizeValue(configuration.get('databricksProfile')),
    clusterId,
    serverless: serverlessEnabled ? 'Enabled' : 'Disabled',
    openPyAsNotebook: Boolean(configuration.get('openPyFilesAsNotebook')) ? 'Enabled' : 'Disabled',
    widgets: extractWidgetsFromActiveContext(configuration.get('widgetValues', {})),
  };
}

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
