// Unity Catalog / local warehouse explorer — a lazy native tree view in the
// same spirit as databricks-vscode's ui/unity-catalog. Explores whichever
// source is selected (view title switch):
//   local      — schemas/tables of the active pool's warehouse over Spark Connect
//   databricks — catalogs/schemas/tables of the workspace over the REST SDK
// Root rows are catalogs; expanding descends schemas -> tables -> columns.

const path = require('node:path');
const vscode = require('vscode');
const poolManager = require('../poolManager');
const { getConfiguration } = require('../config');
const { resolveCommandParts } = require('../pythonEnv');
const state = require('../state');

const EXPLORER_SCRIPT = path.join(__dirname, '..', 'python', 'uc_explore.py');

// ---------------------------------------------------------------------------
// Local warehouse exploration reads the DELTA FILES ON DISK. Sail's metastore
// is session-scoped (tables created in one session vanish from the catalog in
// the next), but the Delta files are durable — and they are exactly what the
// lakehouse container browses. No pool connection is needed.

function getPoolWarehouse(poolName) {
  return path.join(poolManager.getWarehouseRoot(), poolName);
}

// A directory is a Delta table when it contains a _delta_log folder.
function isDeltaTableDir(dirPath) {
  try {
    return fs.existsSync(path.join(dirPath, '_delta_log'));
  } catch {
    return false;
  }
}

// Sail names managed tables unpredictably (e.g. "orders-f731c9ab-..." at the
// warehouse root), so we scan the whole warehouse for Delta tables and group
// them by location instead of assuming a schema-folder layout.
function findLocalTables(poolName) {
  const root = getPoolWarehouse(poolName);
  const tables = [];

  const walk = (dirPath, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      const child = path.join(dirPath, entry.name);

      if (isDeltaTableDir(child)) {
        tables.push({ dir: child, rel: path.relative(root, child).replace(/\\/g, '/') });
      } else if (depth < 4) {
        walk(child, depth + 1);
      }
    }
  };

  walk(root, 0);
  return tables;
}

// "orders-f731c9ab-3cba-4611-bac0-c26ea422b5ca" -> "orders"
function stripUuidSuffix(name) {
  return name.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '');
}

// Groups tables by their location: demo.db/orders -> "demo",
// spark-warehouse/items-uuid -> "spark-warehouse", root-level -> "warehouse root".
function groupLocalTables(tables) {
  const groups = new Map();

  for (const table of tables) {
    const parts = table.rel.split('/');
    let group;

    if (parts.length === 1) {
      group = 'warehouse root';
    } else if (parts.length === 2 && parts[0] === 'spark-warehouse') {
      group = 'spark-warehouse';
    } else {
      group = parts[0].replace(/\.db$/i, '');
    }

    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group).push(table);
  }

  return groups;
}

// The first JSON commit in _delta_log holds the table schema in metaData.
function readDeltaColumns(tableDir) {
  try {
    const logs = fs
      .readdirSync(path.join(tableDir, '_delta_log'))
      .filter((name) => name.endsWith('.json'))
      .sort();

    for (const logName of logs) {
      const content = fs.readFileSync(path.join(tableDir, '_delta_log', logName), 'utf8');

      for (const line of content.split('\n')) {
        if (!line.includes('"metaData"')) {
          continue;
        }

        const action = JSON.parse(line);
        const schema = JSON.parse(action.metaData.schemaString);
        return (schema.fields || []).map((field) => ({
          name: field.name,
          detail: field.type && field.type.name ? field.type.name : field.type,
        }));
      }
    }
  } catch {
    // Fall through to the empty listing below.
  }

  return [];
}

// ---------------------------------------------------------------------------
// Databricks exploration goes through the REST SDK (no compute required) via
// the uc_explore.py one-shot driver.

async function listLevel(source, level, parent, output) {
  const configuration = getConfiguration();
  const pool = poolManager.getPool(configuration.localPool);
  const commandParts = resolveCommandParts(configuration.pythonCommand);

  if (commandParts.length === 0) {
    throw new Error(`Could not resolve the Python command "${configuration.pythonCommand}".`);
  }

  const args = [
    ...commandParts.slice(1),
    EXPLORER_SCRIPT,
    '--source', source,
    '--level', level,
  ];

  if (parent && parent.catalog) {
    args.push('--catalog', parent.catalog);
  }
  if (parent && parent.schema) {
    args.push('--schema', parent.schema);
  }
  if (parent && parent.table) {
    args.push('--table', parent.table);
  }

  if (source === 'local') {
    if (!pool) {
      throw new Error('No local Spark pool is selected.');
    }
    if (!(await poolManager.isPoolServing(pool))) {
      throw new Error(`Local Spark pool "${pool.name}" is not running. Start it from the Configuration panel.`);
    }
    args.push('--pool', `sc://127.0.0.1:${pool.port}`);
  } else if (configuration.databricksProfile) {
    args.push('--profile', configuration.databricksProfile);
  }

  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(commandParts[0], args, {
      shell: false,
      windowsHide: true,
    });

    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      if (output && chunk.toString().trim()) {
        output.appendLine(`[uc-explorer] ${chunk.toString().trimEnd()}`);
      }
    });

    child.on('error', (error) => reject(error));

    child.on('close', (code) => {
      try {
        const message = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || '{}');

        if (message.type === 'error') {
          reject(new Error(message.message));
          return;
        }

        resolve(message.items || []);
      } catch (error) {
        reject(new Error(`Explorer output could not be parsed (exit ${code}).`));
      }
    });
  });
}

// Resolves the effective source honoring the 'auto' setting.
function resolveSource() {
  const configuration = getConfiguration();
  const setting = configuration.ucExplorerSource || 'auto';

  if (setting === 'local' || setting === 'databricks') {
    return setting;
  }

  // auto: local when a local pool is running, else databricks.
  const pool = poolManager.getPool(configuration.localPool);
  if (pool && poolManager.isPoolRunning(pool)) {
    return 'local';
  }
  return 'databricks';
}

class UnityCatalogTreeProvider {
  constructor(output) {
    this.output = output;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.cache = new Map(); // path key -> items
  }

  refresh() {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren(element) {
    const configuration = getConfiguration();
    const source = resolveSource();

    if (!element) {
      if (source === 'local') {
        return this.loadLocalRoot(configuration);
      }
      return this.loadLevel(source, 'catalogs', undefined);
    }

    if (element.errorRow) {
      return [];
    }

    const payload = element.payload || {};

    if (payload.localSchema) {
      return this.loadLocalTables(payload.localSchema);
    }

    if (payload.localTableDir) {
      return readDeltaColumns(payload.localTableDir).map((column) =>
        node(column.name, 'column', column.detail, {
          icon: 'symbol-field',
          payload: { copyValue: column.name },
        })
      );
    }

    const { kind, catalog, schema, name } = payload;

    if (kind === 'catalog') {
      return this.loadLevel(source, 'schemas', { catalog: name });
    }

    if (kind === 'schema') {
      return this.loadLevel(source, 'tables', { catalog, schema: name });
    }

    if (kind === 'table') {
      return this.loadLevel(source, 'table-details', { catalog, schema, table: name });
    }

    return [];
  }

  // ---- local disk exploration ----

  loadLocalRoot(configuration) {
    const pool = poolManager.getPool(configuration.localPool);

    if (!pool) {
      return [errorRow('No local pool selected — click to manage pools', 'sparkCellRunner.poolMenu')];
    }

    const tables = findLocalTables(pool.name);

    if (!tables.length) {
      return [
        errorRow(
          `No Delta tables found in ${getPoolWarehouse(pool.name)} — run examples/02, then click here to refresh`,
          'sparkCellRunner.ucExplorer.refresh'
        ),
        node('Open warehouse folder', undefined, undefined, {
          icon: 'folder-opened',
          command: { command: 'sparkCellRunner.ucExplorer.openWarehouse', title: 'Open Warehouse Folder' },
          payload: {},
        }),
      ];
    }

    const groups = groupLocalTables(tables);

    // A single group is flattened so tables appear directly at the root —
    // one less click for the common case.
    if (groups.size === 1) {
      const [group, groupTables] = [...groups.entries()][0];
      return groupTables.map((table) => this.localTableRow(table, group));
    }

    return [...groups.entries()].map(([group, groupTables]) =>
      collapsible(
        group,
        `${groupTables.length} table${groupTables.length === 1 ? '' : 's'}`,
        'file-directory',
        groupTables.map((table) => this.localTableRow(table, group))
      )
    );
  }

  localTableRow(table, group) {
    const rawName = path.basename(table.dir);
    const displayName = stripUuidSuffix(rawName);
    const shortId = rawName === displayName ? '' : rawName.slice(displayName.length + 1, displayName.length + 9);

    return node(displayName, 'table', `delta${shortId ? ' • ' + shortId : ''}`, {
      collapsible: true,
      icon: 'table',
      payload: {
        localTableDir: table.dir,
        copyValue: table.rel,
      },
      contextValue: 'uc-table-local',
      tooltip: `${group}/${rawName}\n\nColumns expand below; right-click to copy the path`,
    });
  }

  async loadLevel(source, level, parent) {
    const cacheKey = stableKey(source, level, parent);

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    let items;
    try {
      items = await listLevel(source, level, parent, this.output);
    } catch (error) {
      const row = errorRow(error.message, 'sparkCellRunner.poolMenu');
      this.cache.set(cacheKey, [row]);
      return [row];
    }

    const treeItems = items.map((entry) => {
      if (level === 'catalogs') {
        if (source === 'local') {
          // No catalog layer locally: databases act as schemas.
          return node(entry.name, 'schema', entry.detail, {
            collapsible: true,
            icon: 'file-directory',
            payload: { copyValue: entry.name },
          });
        }
        return node(entry.name, 'catalog', entry.detail, {
          collapsible: true,
          icon: 'cloud',
          payload: { copyValue: entry.name },
        });
      }

      if (level === 'schemas') {
        return node(entry.name, 'schema', entry.detail, {
          collapsible: true,
          icon: 'folder-library',
          catalog: parent.catalog,
          payload: { copyValue: parent.catalog ? `${parent.catalog}.${entry.name}` : entry.name },
        });
      }

      if (level === 'tables') {
        const qualified = parent && parent.catalog
          ? `${parent.catalog}.${parent.schema}.${entry.name}`
          : `${parent.schema}.${entry.name}`;
        return node(entry.name, 'table', entry.detail, {
          collapsible: true,
          icon: 'table',
          catalog: parent.catalog,
          schema: parent.schema,
          payload: {
            copyValue: qualified,
            source,
            catalog: parent.catalog,
            schema: parent.schema,
            table: entry.name,
          },
        });
      }

      return node(entry.name, 'column', entry.detail, {
        icon: 'symbol-field',
        payload: { copyValue: entry.name },
      });
    });

    if (treeItems.length === 0) {
      const empty = node('(empty)', undefined, undefined, { icon: 'circle-large-outline' });
      this.cache.set(cacheKey, [empty]);
      return [empty];
    }

    this.cache.set(cacheKey, treeItems);
    return treeItems;
  }
}

function node(label, kind, detail, { collapsible, icon, catalog, schema, table, payload, command } = {}) {
  const item = new vscode.TreeItem(
    label,
    collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );

  if (detail) {
    item.description = detail;
  }
  if (icon) {
    item.iconPath = new vscode.ThemeIcon(icon);
  }
  if (collapsible) {
    item.contextValue = `uc-${kind}`;
  } else if (kind === 'column') {
    item.contextValue = 'uc-column';
  }
  if (payload) {
    item.payload = payload;
    if (payload.copyValue) {
      item.tooltip = `${payload.copyValue}\n\nRight-click to copy${kind === 'table' ? ' or sync' : ''}`;
    }
  }
  item.payload = { ...(item.payload || {}), kind, catalog, schema, table: table || (payload && payload.table) };
  return item;
}

function errorRow(message, commandId) {
  const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('warning');
  item.contextValue = 'uc-error';
  item.errorRow = true;
  item.command = { command: commandId, title: 'Manage' };
  return item;
}

function stableKey(source, level, parent) {
  return [source, level, parent && parent.catalog, parent && parent.schema, parent && parent.table]
    .filter((part) => part !== undefined)
    .join('/');
}

function registerUnityCatalogTree(context, output) {
  const provider = new UnityCatalogTreeProvider(output);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sparkCellRunner.unityCatalogView', provider),
    vscode.commands.registerCommand('sparkCellRunner.ucExplorer.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('sparkCellRunner.ucExplorer.switchSource', async () => {
      const current = resolveSource();
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(server) Local warehouse', source: 'local', detail: 'Schemas/tables of the active pool (Spark Connect)' },
          { label: '$(cloud) Databricks Unity Catalog', source: 'databricks', detail: 'Catalogs of the workspace over REST (no compute needed)' },
          { label: '$(zap) Auto', source: 'auto', detail: 'Local when the pool is running, Databricks otherwise' },
        ],
        { title: 'Explore which catalog?' }
      );

      if (!pick) {
        return;
      }

      await vscode.workspace
        .getConfiguration('sparkCellRunner')
        .update('ucExplorerSource', pick.source, vscode.ConfigurationTarget.Workspace);
      provider.refresh();
      void vscode.window.showInformationMessage(
        `Unity Catalog explorer source: ${current} → ${resolveSource()}`
      );
    }),
    vscode.commands.registerCommand('sparkCellRunner.ucExplorer.copyName', async (item) => {
      const value = item && item.payload && item.payload.copyValue;
      if (!value) {
        return;
      }
      await vscode.env.clipboard.writeText(value);
      void vscode.window.showInformationMessage(`Copied: ${value}`);
    }),
    vscode.commands.registerCommand('sparkCellRunner.ucExplorer.syncTable', async (item) => {
      const payload = item && item.payload;
      if (!payload || !payload.table) {
        return;
      }

      const mode = await vscode.window.showQuickPick(
        [
          { label: '$(cloud-download) Schema only', mode: 'schema' },
          { label: '$(cloud-download) Schema + data', mode: 'data' },
        ],
        { title: `Sync ${payload.catalog}.${payload.schema}.${payload.table} to the local pool` }
      );
      if (!mode) {
        return;
      }

      await vscode.commands.executeCommand('sparkCellRunner.syncUnityCatalog', mode.mode, {
        catalog: payload.catalog,
        schema: payload.schema,
        tables: payload.table,
      });
    }),
    // Refresh the explorer whenever pool state may have changed.
    vscode.window.onDidChangeActiveNotebookEditor(() => provider.refresh()),
  );

  // Keep the sync overrides in sync state so ucSync can target one table.
  return { refresh: () => provider.refresh() };
}

module.exports = { registerUnityCatalogTree, UnityCatalogTreeProvider };
