// Shared mutable extension state. Singletons that used to be module-level
// variables in the original monolithic extension.js live here so separate
// modules can share them without circular requires.

const state = {
  // OutputChannel('Spark Cell Runner'), created in activate().
  output: undefined,

  // Sidebar refresh handle returned by registerDatabricksSidebar().
  databricksSidebar: undefined,

  // Fired whenever run state changes so CodeLens values refresh.
  codeLensChangeEmitter: undefined,

  // documentUri -> Map(cellIndex -> run state)
  runStateByDocument: new Map(),

  // notebookSessionKey -> spawned python session (see session.js)
  notebookSessions: new Map(),

  // notebookSessionKey -> { executedCells: Set<cellIndex> }
  notebookRunHistory: new Map(),

  // Resolved per-document Python interpreter commands.
  resolvedPythonCommandCache: new Map(),

  // Parsed %run include notebooks keyed by absolute path.
  globalIncludeCache: new Map(),

  // Databricks Connect validation results keyed by config signature.
  connectValidationCache: new Map(),
};

module.exports = state;
