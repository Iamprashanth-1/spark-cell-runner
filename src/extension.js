// Spark Cell Runner — extension entry point.
//
// Activate/deactivate wiring only; the implementation lives in focused modules:
//   parser.js        — notebook-source text parsing and magic handling
//   serializer.js    — notebook <-> .py source serialization
//   codelens.js      — run/preview CodeLenses in the text editor view
//   navigation.js    — Go to Definition / Find References remapping
//   scriptBuilder.js — generated script construction and %run expansion
//   session.js       — persistent per-notebook Python session processes
//   runner.js        — cell execution orchestration and notebook controllers
//   pythonEnv.js     — interpreter discovery and Databricks Connect validation
//   pyResources.js   — loads the Python bootstrap/runtime templates in src/python
//   commands.js      — command registrations
//   ui/              — sidebar, status bar, decorations, results panel

const vscode = require('vscode');
const state = require('./state');
const { getConfiguration, clearConnectValidationCache } = require('./config');
const { registerConfigurationTree } = require('./ui/configurationTree');
const { initStatusBar, updateStatusBar, getActiveDatabricksUri } = require('./ui/statusBar');
const decorations = require('./ui/decorations');
const { disposeResultPanel } = require('./ui/resultPanel');
const { DatabricksNotebookSerializer } = require('./serializer');
const { DatabricksNotebookCodeLensProvider } = require('./codelens');
const {
  DatabricksNotebookNavigationProvider,
  redirectConcatEditorToCell,
  closeConcatTabAndReveal,
  syncPyEditorAssociation,
  reopenActivePyForCurrentMode,
} = require('./navigation');
const { registerCommands } = require('./commands');
const runner = require('./runner');
const session = require('./session');
const pythonEnv = require('./pythonEnv');
const { NOTEBOOK_TYPE, JUPYTER_NOTEBOOK_TYPE } = require('./constants');

function activate(context) {
  const output = vscode.window.createOutputChannel('Spark Cell Runner');
  state.output = output;
  context.subscriptions.push(output);
  state.configurationTree = registerConfigurationTree(context);
  initStatusBar(context);
  decorations.createRunDecorations();
  state.codeLensChangeEmitter = new vscode.EventEmitter();
  context.subscriptions.push(
    state.codeLensChangeEmitter,
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.refreshAllRunDecorations()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void redirectConcatEditorToCell(editor);
      }
      updateStatusBar(editor ? editor.document.uri : undefined);
      refreshDatabricksSidebar();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      void redirectConcatEditorToCell(event.textEditor);
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.opened) {
        void closeConcatTabAndReveal(tab);
      }
    }),
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      updateStatusBar(editor ? editor.notebook.uri : undefined);
      refreshDatabricksSidebar();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && event.document === activeEditor.document) {
        refreshDatabricksSidebar();
      }
    }),
    vscode.workspace.onDidChangeNotebookDocument(() => {
      refreshDatabricksSidebar();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      decorations.clearRunStateForDocument(document);
      pythonEnv.clearResolvedPythonCommandForDocument(document);
      decorations.refreshAllRunDecorations();
      state.codeLensChangeEmitter.fire();
    }),
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      session.disposeNotebookSession(notebook.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sparkCellRunner') || event.affectsConfiguration('python')) {
        clearConnectValidationCache();
        pythonEnv.clearResolvedPythonCommandCache();
        updateStatusBar(getActiveDatabricksUri());
        refreshDatabricksSidebar();
        if (event.affectsConfiguration('sparkCellRunner.openPyFilesAsNotebook')) {
          void syncPyEditorAssociation().then(() => reopenActivePyForCurrentMode());
        }
      }
    }),
  );

  const serializer = new DatabricksNotebookSerializer();
  context.subscriptions.push(vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, {
    transientOutputs: false,
    transientDocumentMetadata: false,
    transientCellMetadata: false,
  }));

  runner.registerNotebookControllers(context, output);

  const codeLensProvider = new DatabricksNotebookCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'python', scheme: 'file' }, { language: 'python', scheme: 'untitled' }],
      codeLensProvider,
    ),
  );

  const notebookNavigationProvider = new DatabricksNotebookNavigationProvider();
  const notebookCellSelector = { language: 'python', scheme: 'vscode-notebook-cell' };
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(notebookCellSelector, notebookNavigationProvider),
    vscode.languages.registerReferenceProvider(notebookCellSelector, notebookNavigationProvider),
  );

  registerCommands(context, output);

  void syncPyEditorAssociation();
  updateStatusBar(getActiveDatabricksUri());
}

function deactivate() {
  session.disposeAllNotebookSessions();
  state.connectValidationCache.clear();
  state.globalIncludeCache.clear();
  disposeResultPanel();
}

function refreshDatabricksSidebar() {
  if (state.configurationTree) {
    state.configurationTree.refresh();
  }
}

module.exports = {
  activate,
  deactivate,
};
