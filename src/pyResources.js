// Loads the Python source templates that used to be hardcoded as JS string
// arrays in extension.js. The templates live in src/python/ so they can be
// read and edited as real Python files.

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

const resourceCache = new Map();

async function loadPythonResource(fileName) {
  let cached = resourceCache.get(fileName);

  if (!cached) {
    const filePath = path.join(__dirname, 'python', fileName);
    cached = await fs.readFile(filePath, 'utf8');
    resourceCache.set(fileName, cached);
  }

  return cached;
}

// Absolute path of the long-lived session driver script spawned with
// `python -u session_driver.py`; it speaks the JSON exec protocol over stdio.
function getSessionDriverPath() {
  return path.join(__dirname, 'python', 'session_driver.py');
}

// Returns the bootstrap source with the DatabricksSession builder line filled
// in from the current serverless/clusterId settings. The session compares the
// exact text to detect bootstrap changes, so the result must be deterministic.
async function buildBootstrapCode() {
  const configuration = config.getConfiguration();
  const template = await loadPythonResource('bootstrap.py');

  const builderLine = configuration.useServerless
    ? `_dcr_builder = DatabricksSession.builder.serverless(True)`
    : `_dcr_builder = DatabricksSession.builder.clusterId(${JSON.stringify(configuration.clusterId)})`;

  return template.replace('__DCR_BUILDER_LINE__', () => builderLine);
}

// Returns the runtime-data source with the current workspace path mappings,
// secret replacements, and widget values injected as JSON literals.
async function buildRuntimeDataCode() {
  const configuration = config.getConfiguration();
  const template = await loadPythonResource('runtime_data.py');

  return template
    .replace('__DCR_WORKSPACE_PATH_MAPPINGS__', () => config.stableStringify(configuration.workspacePathMappings || {}))
    .replace('__DCR_SECRET_VALUES__', () => config.stableStringify(configuration.secretValues || {}))
    .replace('__DCR_WIDGET_VALUES__', () => config.stableStringify(configuration.widgetValues || {}));
}

module.exports = {
  loadPythonResource,
  getSessionDriverPath,
  buildBootstrapCode,
  buildRuntimeDataCode,
};
