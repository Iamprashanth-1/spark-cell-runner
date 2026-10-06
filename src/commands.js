// Command registrations for the Spark Cell Runner extension.

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { NOTEBOOK_TYPE } = require('./constants');
const { parseNotebookText, findCellIndexForLine } = require('./parser');
const { getConfiguration, updateWorkspaceSetting, clearConnectValidationCache } = require('./config');
const runner = require('./runner');
const scriptBuilder = require('./scriptBuilder');
const session = require('./session');
const pythonEnv = require('./pythonEnv');
const poolManager = require('./poolManager');
const containerManager = require('./containerManager');
const sqlRunner = require('./sqlRunner');
const ucSync = require('./ucSync');
const state = require('./state');
const decorations = require('./ui/decorations');
const { showRunResultPanel } = require('./ui/resultPanel');
const { syncPyEditorAssociation, reopenActivePyForCurrentMode } = require('./navigation');

function getActiveDocument() {
  return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined;
}

function refreshDatabricksSidebar() {
  if (state.configurationTree) {
    state.configurationTree.refresh();
  }
}

async function pickLocalPool(title) {
  const pools = poolManager.listPools();

  if (pools.length === 0) {
    void vscode.window.showInformationMessage(
      'No local Spark pools exist yet. Run "Spark Cell Runner: Create Local Spark Pool" first.'
    );
    return undefined;
  }

  if (pools.length === 1) {
    return pools[0];
  }

  const pick = await vscode.window.showQuickPick(
    pools.map((pool) => ({
      label: pool.name,
      description: `port ${pool.port} • ${pool.running ? 'running' : 'stopped'}`,
      pool,
    })),
    { title, placeHolder: 'Select a local Spark pool' }
  );

  return pick ? pick.pool : undefined;
}

async function ensureSailInstalled(pythonCommand) {
  if (await poolManager.isSailInstalled(pythonCommand)) {
    return true;
  }

  const install = await vscode.window.showWarningMessage(
    `pysail / pyspark-client are not installed in "${pythonCommand}". Install them into this environment now?`,
    'Install'
  );

  if (install !== 'Install') {
    return false;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Installing pysail and pyspark-client...' },
    () => poolManager.installSail(pythonCommand, state.output)
  );

  return true;
}

// Asks which Python environment to target (venv discovery + manual path).
async function pickPythonEnvironment(title, document) {
  const candidates = await pythonEnv.discoverPythonCandidates(document);
  const current = getConfiguration().pythonCommand;

  const items = candidates.map((candidate) => ({
    label: candidate,
    description: candidate === current ? 'current runner environment' : undefined,
  }));
  items.push({ label: '$(pencil) Enter a Python path manually...', manual: true });

  const pick = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Pick a virtual environment or interpreter (Sail is installed into the one you pick)',
    ignoreFocusOut: true,
  });

  if (!pick) {
    return undefined;
  }

  if (!pick.manual) {
    return pick.label;
  }

  const manual = await vscode.window.showInputBox({
    title,
    prompt: 'Path to a python.exe or a virtual environment folder',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Enter a path.';
      }
      if (trimmed.includes(path.sep) && !fs.existsSync(trimmed)) {
        return 'That path does not exist.';
      }
      return undefined;
    },
  });

  return manual ? manual.trim() : undefined;
}

async function startPoolWithFeedback(pool) {
  if (!(await ensureSailInstalled(pool.pythonCommand))) {
    return;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting local Spark pool "${pool.name}"...` },
      () => poolManager.startPool(pool.name, state.output)
    );
    void vscode.window.showInformationMessage(
      `Local Spark pool "${pool.name}" is serving on sc://127.0.0.1:${pool.port}.`
    );
  } catch (error) {
    state.output.show(true);
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
  }

  refreshDatabricksSidebar();
}

function registerCommands(context, output) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.openAsNotebook', async (uri) => {
      const targetUri = uri
        || (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : undefined)
        || (vscode.window.activeNotebookEditor ? vscode.window.activeNotebookEditor.notebook.uri : undefined);

      if (!targetUri) {
        void vscode.window.showInformationMessage('Open a .py file first, then run "Open as Databricks Notebook".');
        return;
      }

      try {
        await vscode.commands.executeCommand('vscode.openWith', targetUri, NOTEBOOK_TYPE);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not open as Databricks notebook: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.restartNotebookSession', async (uri) => {
      const targetUri = uri || (vscode.window.activeNotebookEditor ? vscode.window.activeNotebookEditor.notebook.uri : undefined);
      if (!targetUri) {
        void vscode.window.showInformationMessage('No active Databricks notebook session to restart.');
        return;
      }
      session.disposeNotebookSession(targetUri);
      clearConnectValidationCache();
      void vscode.window.showInformationMessage('Databricks notebook session restarted.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.runNotebookToCurrentCell', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('No active Databricks notebook editor found.');
        return;
      }
      const endIndex = editor.selection ? editor.selection.start + 1 : editor.notebook.cellCount;
      const cells = editor.notebook.getCells().slice(0, endIndex);
      await runner.executeNotebookCells(cells, editor.notebook, output);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.insertSqlFilterTemplate', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('No active Databricks notebook editor found.');
        return;
      }
      const cell = editor.notebook.cellAt(editor.selection.start);
      const existing = cell.document.getText().trimEnd();
      const template = existing
        ? `${existing}\n\n-- Search template\nWHERE <column> LIKE '%<value>%'\nLIMIT 50`
        : `%sql\nSELECT *\nFROM <catalog>.<schema>.<table>\nWHERE <column> LIKE '%<value>%'\nLIMIT 50`;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), template);
      await vscode.workspace.applyEdit(edit);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.runCurrentCell', async (line) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      await runner.runNotebookCells(editor.document, output, line);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.runAllCells', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      await runner.runNotebookCells(editor.document, output);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.previewCurrentCell', async (line) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const preview = await scriptBuilder.buildScriptForDocument(editor.document, output, line);
      if (!preview) {
        return;
      }

      const document = await vscode.workspace.openTextDocument({
        content: preview.script,
        language: 'python',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.useActivePythonInterpreter', async () => {
      const document = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined;
      const interpreter = await pythonEnv.detectPythonInterpreter(document);
      if (!interpreter) {
        void vscode.window.showWarningMessage('Could not detect an active VS Code Python interpreter.');
        return;
      }

      await pythonEnv.updatePythonCommandSetting(document, interpreter);
      void vscode.window.showInformationMessage(`Spark Cell Runner will use: ${interpreter}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.selectPythonEnvironment', async () => {
      const document = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined;
      await pythonEnv.selectPythonEnvironment(document);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.setClusterId', async () => {
      const document = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined;
      const current = getConfiguration().clusterId;
      const clusterId = await vscode.window.showInputBox({
        title: 'Set Databricks Cluster ID',
        prompt: 'Enter the Databricks cluster ID to use for Databricks Connect runs',
        value: current,
        ignoreFocusOut: true,
      });

      if (clusterId === undefined) {
        return;
      }

      await updateWorkspaceSetting('clusterId', clusterId.trim(), document);
      void vscode.window.showInformationMessage(`Spark Cell Runner cluster set to: ${clusterId.trim() || '(empty)'}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.toggleServerlessMode', async () => {
      const document = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined;
      const enabled = !getConfiguration().useServerless;
      await updateWorkspaceSetting('useServerless', enabled, document);
      void vscode.window.showInformationMessage(`Spark Cell Runner serverless mode ${enabled ? 'enabled' : 'disabled'}.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.setPythonEnvironmentPath', async () => {
      const document = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined;
      await pythonEnv.promptForPythonEnvironmentPath(document);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.showCellOutput', async (line) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const parsed = parseNotebookText(editor.document.uri.fsPath, editor.document.getText());
      const cellIndex = typeof line === 'number' ? findCellIndexForLine(parsed.cells, line) : -1;
      const runState = decorations.getCellRunState(editor.document.uri, cellIndex);
      if (!runState || !runState.payload) {
        void vscode.window.showInformationMessage('No captured output is available for this cell yet.');
        return;
      }

      await showRunResultPanel(runState.payload);
    }),
  );

  // ----- Local Spark pool commands -----

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.setConnectionMode', async (mode) => {
      const document = getActiveDocument();
      let target = mode;

      if (target !== 'local' && target !== 'databricks') {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Databricks (serverless / cluster)', mode: 'databricks' },
            { label: 'Local Spark pool (Sail)', mode: 'local' },
          ],
          { title: 'Set connection mode', placeHolder: 'Where should Spark sessions run?' }
        );
        if (!pick) {
          return;
        }
        target = pick.mode;
      }

      await updateWorkspaceSetting('connectionMode', target, document);

      if (target === 'local') {
        const pools = poolManager.listPools();
        const current = getConfiguration().localPool;
        if (pools.length > 0 && !pools.some((pool) => pool.name === current)) {
          await updateWorkspaceSetting('localPool', pools[0].name, document);
          void vscode.window.showInformationMessage(`Local Spark pool mode enabled using pool "${pools[0].name}".`);
        } else {
          void vscode.window.showInformationMessage('Local Spark pool mode enabled.');
        }
      } else {
        void vscode.window.showInformationMessage('Databricks connection mode enabled.');
      }

      refreshDatabricksSidebar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.createLocalPool', async () => {
      const document = getActiveDocument();

      const name = await vscode.window.showInputBox({
        title: 'New local Spark pool',
        prompt: 'Pool name (letters, digits, dots, dashes, underscores)',
        value: 'local',
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }

      const pythonCommand = await pickPythonEnvironment('Python environment for the pool', document);
      if (!pythonCommand) {
        return;
      }

      if (!(await ensureSailInstalled(pythonCommand))) {
        void vscode.window.showInformationMessage(
          'Pool creation cancelled — pysail is required in the selected environment. Run "Install Local Pool Packages" to add it later.'
        );
        return;
      }

      const defaultPort = await poolManager.findFreePort();
      const portText = await vscode.window.showInputBox({
        title: 'Spark Connect port',
        prompt: 'Port the pool serves Spark Connect on (sc://127.0.0.1:<port>)',
        value: String(defaultPort),
        validateInput: (value) => {
          const port = Number(value);
          return Number.isInteger(port) && port >= 1 && port <= 65535
            ? undefined
            : 'Enter a port between 1 and 65535.';
        },
        ignoreFocusOut: true,
      });
      if (!portText) {
        return;
      }

      let pool;
      try {
        pool = poolManager.createPool({
          name,
          pythonCommand,
          port: Number(portText),
        });
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        return;
      }

      await updateWorkspaceSetting('localPool', pool.name, document);
      await updateWorkspaceSetting('connectionMode', 'local', document);
      void vscode.window.showInformationMessage(
        `Local Spark pool "${pool.name}" created (warehouse: ${pool.warehousePath}).`
      );

      const startNow = await vscode.window.showInformationMessage(
        `Start pool "${pool.name}" now?`,
        'Start Pool'
      );
      if (startNow === 'Start Pool') {
        await startPoolWithFeedback(pool);
      } else {
        refreshDatabricksSidebar();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.startLocalPool', async (name) => {
      const pool = name ? poolManager.getPool(name) : await pickLocalPool('Start local Spark pool');
      if (!pool) {
        return;
      }
      await startPoolWithFeedback(pool);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.stopLocalPool', async (name) => {
      const pool = name ? poolManager.getPool(name) : await pickLocalPool('Stop local Spark pool');
      if (!pool) {
        return;
      }

      await poolManager.stopPool(pool.name);
      void vscode.window.showInformationMessage(`Local Spark pool "${pool.name}" stopped.`);
      refreshDatabricksSidebar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.showPoolLogs', async (name) => {
      const pool = name ? poolManager.getPool(name) : await pickLocalPool('Show pool logs');
      if (!pool) {
        return;
      }

      if (!fs.existsSync(pool.logFile)) {
        fs.mkdirSync(path.dirname(pool.logFile), { recursive: true });
        fs.writeFileSync(pool.logFile, `No output yet for pool "${pool.name}".\n`);
      }

      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(pool.logFile));
      await vscode.window.showTextDocument(document, { preview: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.deleteLocalPool', async (name) => {
      const pool = name ? poolManager.getPool(name) : await pickLocalPool('Delete local Spark pool');
      if (!pool) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete local Spark pool "${pool.name}"? The warehouse folder on disk is kept.`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') {
        return;
      }

      await poolManager.deletePool(pool.name);

      const configuration = getConfiguration();
      if (configuration.localPool === pool.name) {
        await updateWorkspaceSetting('localPool', '', getActiveDocument());
      }

      void vscode.window.showInformationMessage(`Local Spark pool "${pool.name}" deleted.`);
      refreshDatabricksSidebar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.installLocalPoolPackages', async () => {
      const document = getActiveDocument();
      const pythonCommand = await pickPythonEnvironment(
        'Install pysail into which Python environment?',
        document
      );

      if (!pythonCommand) {
        return;
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Installing pysail and pyspark-client into ${pythonCommand}...` },
          () => poolManager.installSail(pythonCommand, state.output)
        );

        const installed = await poolManager.isSailInstalled(pythonCommand);
        if (installed) {
          void vscode.window.showInformationMessage(`pysail and pyspark-client installed into ${pythonCommand}.`);
        } else {
          void vscode.window.showWarningMessage(`Install finished, but "import pysail, pyspark" still fails in ${pythonCommand}. Check the output channel.`);
        }
      } catch (error) {
        state.output.show(true);
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }

      refreshDatabricksSidebar();
    }),
  );

  // ----- Unity Catalog sync -----

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.syncUnityCatalog', async (modeOverride, overrides) => {
      const configuration = getConfiguration();
      const pool = poolManager.getPool(configuration.localPool);

      if (!pool) {
        void vscode.window.showErrorMessage(
          'No local Spark pool is selected. Create one from the Configuration panel before syncing.'
        );
        return;
      }

      if (!(await poolManager.isPoolServing(pool))) {
        const start = await vscode.window.showWarningMessage(
          `Local Spark pool "${pool.name}" is not running. Start it now?`,
          'Start Pool'
        );
        if (start === 'Start Pool') {
          await startPoolWithFeedback(pool);
          if (!(await poolManager.isPoolServing(pool))) {
            return;
          }
        } else {
          return;
        }
      }

      state.output.show(true);

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Syncing Unity Catalog to local pool...',
            cancellable: false,
          },
          (progress) => ucSync.runSync(state.output, (message) => {
            progress.report({ message: message.length > 60 ? `${message.slice(0, 57)}...` : message });
          }, { mode: arguments && arguments[0] })
        );

        if (result.ok) {
          void vscode.window.showInformationMessage(`Unity Catalog sync finished: ${result.summary}`);
        } else {
          void vscode.window.showWarningMessage(`Unity Catalog sync finished with issues: ${result.summary}`);
        }
      } catch (error) {
        state.output.appendLine(`[sync] failed: ${error.message || error}`);
        void vscode.window.showErrorMessage(
          `Unity Catalog sync failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      refreshDatabricksSidebar();
    }),
  );

  // ----- Lakehouse container (Docker / Podman) -----

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.launchLakehouseContainer', async () => {
      const configuration = getConfiguration();
      const pool = poolManager.getPool(configuration.localPool) || (await pickLocalPool('Launch the lakehouse stack for which pool?'));

      if (!pool) {
        return;
      }

      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Launching lakehouse container stack (${pool.name})...` },
          () => containerManager.launchLakehouse(pool, state.output)
        );

        const creds = result.passwordVerified
          ? `login ${result.username}/${result.password}`
          : `check ${result.credentialsFile} for the login`;
        const open = await vscode.window.showInformationMessage(
          `Lakehouse stack is running on ${result.runtime}. Warehouse UI: ${result.uiUrl} (${creds}). Credentials are stored in ${result.credentialsFile}`,
          'Open Warehouse UI',
          'Show Credentials File'
        );
        if (open === 'Open Warehouse UI') {
          await vscode.env.openExternal(vscode.Uri.parse(result.uiUrl));
        } else if (open === 'Show Credentials File') {
          const document = await vscode.workspace.openTextDocument(result.credentialsFile);
          await vscode.window.showTextDocument(document, { preview: true });
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }

      refreshDatabricksSidebar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.stopLakehouseContainer', async () => {
      const configuration = getConfiguration();
      const pool = poolManager.getPool(configuration.localPool) || (await pickLocalPool('Stop the lakehouse stack for which pool?'));

      if (!pool) {
        return;
      }

      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Stopping lakehouse container stack (${pool.name})...` },
          () => containerManager.stopLakehouse(pool, state.output)
        );
        void vscode.window.showInformationMessage(
          result.stopped ? `Lakehouse stack for "${pool.name}" stopped.` : 'No lakehouse stack was found for this pool.'
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
      }

      refreshDatabricksSidebar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.openLakehouseConsole', async () => {
      await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${containerManager.getCachedUiPort()}`));
    }),
  );

  // ----- Configuration tree (Databricks-style) helpers -----

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.refreshConfiguration', () => {
      refreshDatabricksSidebar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.setDatabricksProfile', async () => {
      const current = getConfiguration().databricksProfile;
      const profile = await vscode.window.showInputBox({
        title: 'Databricks Profile',
        prompt: 'Profile name from ~/.databrickscfg used for authentication (empty = default)',
        value: current,
        ignoreFocusOut: true,
      });
      if (profile === undefined) {
        return;
      }
      await updateWorkspaceSetting('databricksProfile', profile.trim(), getActiveDocument());
      void vscode.window.showInformationMessage(`Databricks profile set to: ${profile.trim() || '(default)'}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.poolMenu', async () => {
      const configuration = getConfiguration();
      const pool = poolManager.getPool(configuration.localPool) || poolManager.listPools()[0];
      const items = [];

      if (pool) {
        items.push(
          { label: pool.running ? '$(debug-stop) Stop pool' : '$(debug-start) Start pool', action: pool.running ? 'stop' : 'start' },
          { label: '$(output) Show pool logs', action: 'logs' },
          { label: '$(arrow-swap) Switch pool...', action: 'switch' },
          { label: '$(trash) Delete pool...', action: 'delete' }
        );
      }
      items.push(
        { label: '$(add) Create new pool...', action: 'create' },
        { label: '$(cloud-download) Install pysail into a venv...', action: 'install' }
      );

      const pick = await vscode.window.showQuickPick(items, {
        title: pool ? `Local Spark pool: ${pool.name}` : 'Local Spark pools',
        placeHolder: 'Manage the local Sail pool',
      });
      if (!pick) {
        return;
      }

      switch (pick.action) {
        case 'start':
          await vscode.commands.executeCommand('sparkCellRunner.startLocalPool', pool.name);
          break;
        case 'stop':
          await vscode.commands.executeCommand('sparkCellRunner.stopLocalPool', pool.name);
          break;
        case 'logs':
          await vscode.commands.executeCommand('sparkCellRunner.showPoolLogs', pool.name);
          break;
        case 'switch': {
          const pools = poolManager.listPools();
          const target = await vscode.window.showQuickPick(
            pools.map((entry) => ({ label: entry.name, description: `port ${entry.port} • ${entry.running ? 'running' : 'stopped'}` })),
            { title: 'Switch to which pool?' }
          );
          if (target) {
            await updateWorkspaceSetting('localPool', target.label, getActiveDocument());
            await updateWorkspaceSetting('connectionMode', 'local', getActiveDocument());
          }
          break;
        }
        case 'delete':
          await vscode.commands.executeCommand('sparkCellRunner.deleteLocalPool', pool && pool.name);
          break;
        case 'create':
          await vscode.commands.executeCommand('sparkCellRunner.createLocalPool');
          break;
        case 'install':
          await vscode.commands.executeCommand('sparkCellRunner.installLocalPoolPackages');
          break;
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.syncMenu', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(cloud-download) Sync now — schema only', mode: 'schema', detail: 'Empty Delta tables with the real column layout; fast, no cluster needed' },
          { label: '$(cloud-download) Sync now — schema + data', mode: 'data', detail: 'Copies rows through a Databricks session (honors the row limit)' },
          { label: '$(settings-gear) Edit sync filters...', action: 'filters', detail: 'Catalog, schema, table pattern, row limit' },
        ],
        { title: 'Unity Catalog → local pool', placeHolder: 'Mirror dev UC tables for offline development' }
      );
      if (!pick) {
        return;
      }

      if (pick.action === 'filters') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'sparkCellRunner.sync');
        return;
      }

      await vscode.commands.executeCommand('sparkCellRunner.syncUnityCatalog', pick.mode);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.containerMenu', async () => {
      const status = containerManager.getCachedStackStatus();
      const pick = await vscode.window.showQuickPick(
        [
          status && status.running
            ? { label: '$(debug-stop) Stop container stack', action: 'stop' }
            : { label: '$(debug-start) Launch container stack', action: 'launch' },
          { label: '$(browser) Open warehouse UI', action: 'open' },
          { label: '$(key) Show credentials file', action: 'credentials' },
        ],
        { title: 'Lakehouse container (Docker/Podman)', placeHolder: 'Browse the local warehouse in Docker/Podman Desktop' }
      );
      if (!pick) {
        return;
      }

      switch (pick.action) {
        case 'launch':
          await vscode.commands.executeCommand('sparkCellRunner.launchLakehouseContainer');
          break;
        case 'stop':
          await vscode.commands.executeCommand('sparkCellRunner.stopLakehouseContainer');
          break;
        case 'open':
          await vscode.commands.executeCommand('sparkCellRunner.openLakehouseConsole');
          break;
        case 'credentials': {
          const configuration = getConfiguration();
          const pool = poolManager.getPool(configuration.localPool);
          if (pool) {
            const document = await vscode.workspace.openTextDocument(containerManager.getCredentialsFilePath(pool.name));
            await vscode.window.showTextDocument(document, { preview: true });
          }
          break;
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.editWidget', async (name, type, choices) => {
      if (!name) {
        return;
      }

      const configuration = getConfiguration();
      const current = configuration.widgetValues[name];

      let value;
      if ((type === 'dropdown' || type === 'combobox') && Array.isArray(choices) && choices.length) {
        const pick = await vscode.window.showQuickPick(
          choices.map((choice) => ({ label: choice })),
          { title: `Widget: ${name}`, placeHolder: 'Pick a value' }
        );
        value = pick ? pick.label : undefined;
      } else {
        value = await vscode.window.showInputBox({
          title: `Widget: ${name}`,
          prompt: 'Value passed to dbutils.widgets.get',
          value: current !== undefined ? String(current) : '',
          ignoreFocusOut: true,
        });
      }

      if (value === undefined) {
        return;
      }

      await updateWorkspaceSetting('widgetValues', { ...configuration.widgetValues, [name]: value }, getActiveDocument());
      void vscode.window.showInformationMessage(`Widget "${name}" set to "${value}".`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.toggleOpenPyAsNotebook', async () => {
      const current = Boolean(vscode.workspace.getConfiguration('sparkCellRunner').get('openPyFilesAsNotebook'));
      await updateWorkspaceSetting('openPyFilesAsNotebook', !current, getActiveDocument());
      await syncPyEditorAssociation();
      await reopenActivePyForCurrentMode();
      void vscode.window.showInformationMessage(
        !current
          ? 'Python files will now open as Databricks notebooks.'
          : 'Python files will now open as plain text.'
      );
    }),
  );

  // ----- Inline tree-row actions (view/item/context buttons) -----

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.tree.poolToggle', async (item) => {
      const poolName = item && item.payload && item.payload.pool;
      if (!poolName) {
        return;
      }
      const pool = poolManager.getPool(poolName);
      if (!pool) {
        return;
      }
      await vscode.commands.executeCommand(
        pool.running ? 'sparkCellRunner.stopLocalPool' : 'sparkCellRunner.startLocalPool',
        poolName
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.tree.syncRun', async (item) => {
      const mode = item && item.payload && item.payload.mode;
      await vscode.commands.executeCommand('sparkCellRunner.syncUnityCatalog', mode);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.tree.containerToggle', async () => {
      const status = containerManager.getCachedStackStatus();
      await vscode.commands.executeCommand(
        status && status.running ? 'sparkCellRunner.stopLakehouseContainer' : 'sparkCellRunner.launchLakehouseContainer'
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.ucExplorer.openWarehouse', async () => {
      const configuration = getConfiguration();
      const pool = poolManager.getPool(configuration.localPool);

      if (!pool) {
        void vscode.window.showInformationMessage('No local Spark pool is selected.');
        return;
      }

      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(pool.warehousePath));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.ucExplorer.previewTable', async (item) => {
      const payload = item && item.payload;

      if (!payload || !payload.localTableDir) {
        void vscode.window.showInformationMessage(
          'Preview reads the local warehouse. For Databricks tables, sync the table first, then expand its local copy.'
        );
        return;
      }

      const configuration = getConfiguration();
      const pool = poolManager.getPool(configuration.localPool);

      if (!pool) {
        void vscode.window.showErrorMessage('No local Spark pool is selected.');
        return;
      }

      if (!(await poolManager.isPoolServing(pool))) {
        const start = await vscode.window.showWarningMessage(
          `Local Spark pool "${pool.name}" is not running. Start it now?`,
          'Start Pool'
        );
        if (start !== 'Start Pool') {
          return;
        }
        await startPoolWithFeedback(pool);
      }

      const commandParts = pythonEnv.resolveCommandParts(
        poolManager.resolveSessionPythonCommand(configuration.pythonCommand, configuration)
      );
      const scriptPath = path.join(__dirname, 'python', 'preview_table.py');

      try {
        const csvText = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Previewing table rows...' },
          () => new Promise((resolve, reject) => {
            const child = require('node:child_process').spawn(
              commandParts[0],
              [...commandParts.slice(1), scriptPath, '--pool', `sc://127.0.0.1:${pool.port}`, '--path', payload.localTableDir, '--limit', '50'],
              { shell: false, windowsHide: true }
            );

            let stdout = '';
            child.stdout.on('data', (chunk) => {
              stdout += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', () => {
              try {
                const message = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || '{}');
                if (message.type === 'error') {
                  reject(new Error(message.message));
                  return;
                }
                resolve(message);
              } catch (error) {
                reject(error);
              }
            });
          })
        );

        state.output.show(true);
        state.output.appendLine(
          `[preview] ${payload.copyValue || payload.localTableDir}: showing ${csvText.shown} of ${csvText.totalRows} rows`
        );

        const header = `-- Preview: ${payload.copyValue || payload.localTableDir}\n-- ${csvText.shown} of ${csvText.totalRows} rows\n\n`;
        const document = await vscode.workspace.openTextDocument({
          content: header + csvText.csv,
          language: 'csv',
        });
        await vscode.window.showTextDocument(document, { preview: true });
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Preview failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),
  );

  // ----- SQL execution on the local pool -----

  const runSql = async (sqlText, sourceLabel, options) => {
    try {
      await sqlRunner.executeSql(sqlText, sourceLabel, options);
      refreshDatabricksSidebar();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `SQL execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const requireLocalMode = () => {
    if (getConfiguration().connectionMode !== 'local') {
      void vscode.window.showInformationMessage(
        'SQL runs on a local pool. Switch the Connection to "Local pool" first.'
      );
      return false;
    }
    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.runSqlFile', async (uri) => {
      if (!requireLocalMode()) {
        return;
      }

      const targetUri = uri
        || (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : undefined);

      if (!targetUri) {
        void vscode.window.showInformationMessage('Open a .sql file first.');
        return;
      }

      const document = await vscode.workspace.openTextDocument(targetUri);
      await runSql(document.getText(), `run ${path.basename(targetUri.fsPath)}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.runSqlSelection', async () => {
      if (!requireLocalMode()) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') {
        void vscode.window.showInformationMessage('Open a .sql file first.');
        return;
      }

      const selection = editor.selection;

      // Explicit selection wins (Databricks-style). With no selection, run the
      // statement under the cursor; an empty document runs the whole file.
      if (selection.isEmpty) {
        const statements = sqlRunner.splitStatements(editor.document.getText());
        const cursorLine = selection.active.line;
        const current = statements.find((statement, index) => {
          const endLine = index + 1 < statements.length
            ? statements[index + 1].startLine - 1
            : editor.document.lineCount;
          return cursorLine >= statement.startLine && cursorLine < endLine;
        });

        if (!current) {
          void vscode.window.showInformationMessage('No SQL statement found at the cursor.');
          return;
        }

        await runSql(current.text, `run statement ${statements.indexOf(current) + 1} (cursor)`);
        return;
      }

      await runSql(editor.document.getText(selection), 'run selection');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.runSqlRange', async (uri, startLine) => {
      if (!requireLocalMode()) {
        return;
      }

      const document = uri
        ? await vscode.workspace.openTextDocument(uri)
        : (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document : undefined);

      if (!document) {
        void vscode.window.showInformationMessage('Open a .sql file first.');
        return;
      }

      const statements = sqlRunner.splitStatements(document.getText());
      const statement = startLine === undefined
        ? statements[statements.length - 1]
        : statements.find((entry) => entry.startLine === startLine) || statements[statements.length - 1];

      await runSql(statement.text, `run statement ${statements.indexOf(statement) + 1}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.ucExplorer.queryTable', async (item) => {
      const payload = item && item.payload;

      if (!payload || !payload.copyValue) {
        return;
      }

      // Named queries (sail.schema.table) resolve because the extension
      // re-registers on-disk warehouse tables into every session it starts.
      // The Delta path is kept as a comment fallback.
      const named = payload.copyValue;
      const fallback = payload.localTableDir
        ? '-- fallback: SELECT * FROM delta.`' + payload.localTableDir.replace(/\\/g, '/') + '` LIMIT 100;'
        : undefined;

      const document = await vscode.workspace.openTextDocument({
        content: `-- Querying ${named}\n-- Run with the CodeLens above, or right-click → "Run Selected SQL on Pool"\n${fallback ? fallback + '\n' : ''}SELECT *\nFROM ${named}\nLIMIT 100;\n`,
        language: 'sql',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.configuration.copyValue', async (item) => {
      const value = item && item.payload && item.payload.copyValue;
      if (!value) {
        void vscode.window.showInformationMessage('Nothing to copy for this row.');
        return;
      }
      await vscode.env.clipboard.writeText(value);
      void vscode.window.showInformationMessage(`Copied: ${value}`);
    }),
  );
}

module.exports = { registerCommands };
