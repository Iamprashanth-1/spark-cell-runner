// Command registrations for the Spark Cell Runner extension.

const vscode = require('vscode');
const { NOTEBOOK_TYPE } = require('./constants');
const { parseNotebookText, findCellIndexForLine } = require('./parser');
const { getConfiguration, updateWorkspaceSetting, clearConnectValidationCache } = require('./config');
const runner = require('./runner');
const scriptBuilder = require('./scriptBuilder');
const session = require('./session');
const pythonEnv = require('./pythonEnv');
const decorations = require('./ui/decorations');
const { showRunResultPanel } = require('./ui/resultPanel');
const { syncPyEditorAssociation, reopenActivePyForCurrentMode } = require('./navigation');

function registerCommands(context, output) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCellRunner.openAsNotebook', async (uri) => {
      const targetUri = uri || (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : undefined);
      if (!targetUri) {
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', targetUri, NOTEBOOK_TYPE);
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
}

module.exports = { registerCommands };
