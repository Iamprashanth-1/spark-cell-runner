// Loads the Python source templates that used to be hardcoded as JS string
// arrays in extension.js. The templates live in src/python/ so they can be
// read and edited as real Python files.

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const poolManager = require('./poolManager');

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

// Returns the bootstrap source with the connection block filled in for the
// current mode: a DatabricksSession builder (databricks mode) or a Spark
// Connect session pointed at the selected local Sail pool (local mode). The
// session compares the exact text to detect bootstrap changes, so the result
// must be deterministic.
async function buildBootstrapCode() {
  const configuration = config.getConfiguration();
  const template = await loadPythonResource('bootstrap.py');

  const connectionBlock = configuration.connectionMode === 'local'
    ? buildLocalConnectionBlock(configuration)
    : buildDatabricksConnectionBlock(configuration);

  return template.replace('__SCR_CONNECTION_BLOCK__', () => connectionBlock);
}

function buildDatabricksConnectionBlock(configuration) {
  const builderLine = configuration.useServerless
    ? `_dcr_builder = DatabricksSession.builder.serverless(True)`
    : `_dcr_builder = DatabricksSession.builder.clusterId(${JSON.stringify(configuration.clusterId)})`;

  return [
    'try:',
    '    from databricks.connect import DatabricksSession',
    `    ${builderLine}`,
    "    spark = globals().get('spark') or __dcr_builder.getOrCreate()",
    "    sql = globals().get('sql') or spark.sql",
    '    try:',
    '        from databricks.sdk import WorkspaceClient',
    '    except Exception:',
    '        pass',
    'except Exception as databricks_connect_error:',
    "    print(f'[spark-cell-runner] Databricks Connect bootstrap unavailable: {databricks_connect_error}')",
  ].join('\n');
}

function buildLocalConnectionBlock(configuration) {
  const pool = poolManager.getPool(configuration.localPool);

  if (!pool) {
    return (
      "print('[spark-cell-runner] Local Spark pool bootstrap unavailable: " +
      'no local pool is selected. Create one from the Spark Cell Runner sidebar.\')'
    );
  }

  return [
    'try:',
    '    from pyspark.sql import SparkSession',
    `    _local_spark_target = 'sc://127.0.0.1:${pool.port}'`,
    "    spark = globals().get('spark') or SparkSession.builder.remote(_local_spark_target).getOrCreate()",
    "    sql = globals().get('sql') or spark.sql",
    '    try:',
    `        spark.conf.set('spark.sql.warehouse.dir', ${JSON.stringify(pool.warehousePath)})`,
    '    except Exception:',
    '        pass',
    'except Exception as databricks_connect_error:',
    "    print(f'[spark-cell-runner] Local Spark pool bootstrap unavailable: {databricks_connect_error}')",
  ].join('\n');
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
