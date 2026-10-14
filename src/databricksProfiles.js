// Databricks CLI profile management (~/.databrickscfg).
//
// Mirrors the auth approach of the official Databricks VS Code extension:
//   - list profiles via `databricks auth profiles --output json`, falling back
//     to parsing ~/.databrickscfg directly when the CLI is unavailable
//   - select a profile via QuickPick (host + auth type shown, tokens never shown)
//   - create a new profile: name -> host -> OAuth (`databricks auth login`,
//     which persists the profile section itself) or PAT (writes the section)
//   - open ~/.databrickscfg for manual edits

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const vscode = require('vscode');
const { resolveDatabricksCliPath } = require('./pythonEnv');

const PROFILE_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

function getDatabricksConfigPath() {
    return path.join(os.homedir(), '.databrickscfg');
}

function findDatabricksCli() {
    const fromEnv = process.env.DATABRICKS_CLI_PATH;

    if (fromEnv && fs.existsSync(fromEnv)) {
        return fromEnv;
    }

    const resolved = resolveDatabricksCliPath();

    if (resolved) {
        return resolved;
    }

    const executable = process.platform === 'win32' ? 'databricks.exe' : 'databricks';
    const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

    for (const directory of directories) {
        const candidate = path.join(directory, executable);

        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function runDatabricksCli(cliPath, args, timeoutMs = 15000) {
    return new Promise((resolve) => {
        execFile(
            cliPath,
            args,
            { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
            (error, stdout, stderr) => {
                resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error });
            }
        );
    });
}

// Minimal INI parsing for ~/.databrickscfg: `[section]` headers plus `key = value`
// lines, `;`/`#` comment lines ignored. Enough to enumerate profile names and
// their host/auth_type without pulling in a dependency.
function parseCfgProfiles(content) {
    const profiles = [];
    let current = undefined;

    for (const rawLine of String(content || '').split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith(';') || line.startsWith('#')) {
            continue;
        }

        const sectionMatch = line.match(/^\[(.+)\]$/);

        if (sectionMatch) {
            current = { name: sectionMatch[1].trim(), host: undefined, authType: undefined };
            profiles.push(current);
            continue;
        }

        const entryMatch = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);

        if (entryMatch && current) {
            const key = entryMatch[1].toLowerCase();
            const value = entryMatch[2].trim();

            if (key === 'host') {
                current.host = value;
            } else if (key === 'auth_type') {
                current.authType = value;
            }
        }
    }

    return profiles;
}

// Lists profiles the same way the Databricks extension does: the CLI reports
// richer metadata (validity, cloud, auth type), but a cfg-file parse keeps the
// picker working when only ~/.databrickscfg exists.
async function listProfiles() {
    const cliPath = findDatabricksCli();

    if (cliPath) {
        const result = await runDatabricksCli(cliPath, ['auth', 'profiles', '--output', 'json']);

        if (result.ok && result.stdout.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(result.stdout);
                const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];

                return profiles
                    .filter((profile) => profile && profile.name)
                    .map((profile) => ({
                        name: profile.name,
                        host: profile.host || undefined,
                        authType: profile.auth_type || undefined,
                        valid: profile.valid !== false,
                    }));
            } catch {
                // Fall through to cfg-file parsing.
            }
        }
    }

    try {
        const content = await fsp.readFile(getDatabricksConfigPath(), 'utf8');
        return parseCfgProfiles(content).map((profile) => ({ ...profile, valid: true }));
    } catch {
        return [];
    }
}

async function selectProfile({ current } = {}) {
    const profiles = await listProfiles();
    const items = [];

    items.push({
        label: '$(circle-slash) (default)',
        description: current ? 'Currently: use default profile / env vars' : 'Currently selected',
        detail: 'Use the DEFAULT profile or DATABRICKS_HOST / DATABRICKS_TOKEN environment variables',
        action: 'set',
        profile: '',
    });

    for (const profile of profiles) {
        items.push({
            label: `$(account) ${profile.name}`,
            description: profile.name === current ? 'Currently selected' : undefined,
            detail: [
                profile.host,
                profile.authType ? `auth: ${profile.authType}` : undefined,
                profile.valid === false ? '⚠ could not validate credentials' : undefined,
            ]
                .filter(Boolean)
                .join(' • '),
            action: 'set',
            profile: profile.name,
        });
    }

    if (profiles.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    items.push(
        {
            label: '$(add) Create new profile...',
            detail: 'Authenticate with OAuth or a personal access token and save it to ~/.databrickscfg',
            action: 'create',
        },
        {
            label: '$(edit) Edit ~/.databrickscfg...',
            detail: 'Open the Databricks config file to manage profiles manually',
            action: 'edit',
        }
    );

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Databricks Profile',
        placeHolder: `Profile from ~/.databrickscfg used for authentication${current ? ` (current: ${current})` : ' (current: default)'}`,
        ignoreFocusOut: true,
    });

    return pick ? { action: pick.action, profile: pick.profile } : undefined;
}

async function inputProfileName(existingNames, suggested) {
    return vscode.window.showInputBox({
        title: 'New Databricks profile — name',
        prompt: 'Profile name to add to ~/.databrickscfg',
        value: suggested || '',
        placeHolder: 'e.g. dev',
        ignoreFocusOut: true,
        validateInput: (value) => {
            const name = value.trim();

            if (!name) {
                return 'Profile name cannot be empty';
            }

            if (!PROFILE_NAME_REGEX.test(name)) {
                return 'Use only letters, digits, hyphens and underscores (no dots or spaces)';
            }

            if (existingNames.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
                return `Profile "${name}" already exists`;
            }

            return undefined;
        },
    });
}

async function inputHost() {
    const fromEnvironment = process.env.DATABRICKS_HOST;
    const host = await vscode.window.showInputBox({
        title: 'New Databricks profile — workspace URL',
        prompt: 'Databricks workspace URL, e.g. https://adb-1234567890.1.azuredatabricks.net',
        value: fromEnvironment || '',
        placeHolder: 'https://<workspace-url>',
        ignoreFocusOut: true,
        validateInput: (value) => {
            const trimmed = value.trim();

            if (!trimmed) {
                return 'Host cannot be empty';
            }

            if (!/^https:\/\/.+/i.test(trimmed)) {
                return 'Host must start with https://';
            }

            return undefined;
        },
    });

    return host ? host.trim().replace(/\/+$/, '') : undefined;
}

// The OAuth flow needs a browser round-trip; `databricks auth login` owns that
// flow and persists the `[<name>]` section to ~/.databrickscfg itself, so we
// run it in a visible terminal rather than capturing output.
async function createProfileWithOAuth(output, profileName, host) {
    const cliPath = findDatabricksCli();

    if (!cliPath) {
        void vscode.window.showErrorMessage(
            'Databricks CLI not found. Install it (https://docs.databricks.com/en/dev-tools/cli/install.html) or create the profile with a personal access token instead.'
        );
        return false;
    }

    const terminal = vscode.window.createTerminal({
        name: `Databricks login: ${profileName}`,
        env: { DATABRICKS_CLI_PATH: cliPath },
    });

    terminal.sendText(`"${cliPath}" auth login --host ${host} --profile ${profileName}`);
    terminal.show();

    const choice = await vscode.window.showInformationMessage(
        `Complete the OAuth sign-in in the "Databricks login: ${profileName}" terminal, then confirm. The CLI writes the [${profileName}] section to ~/.databrickscfg.`,
        { modal: false },
        'Done'
    );

    if (!choice) {
        return false;
    }

    const created = await listProfiles();
    const persisted = created.some((profile) => profile.name === profileName);

    if (!persisted && output) {
        output.appendLine(`[profiles] ${profileName} not found in ~/.databrickscfg after OAuth login; continuing anyway`);
    }

    return true;
}

async function createProfileWithToken(output, profileName, host) {
    const token = await vscode.window.showInputBox({
        title: 'New Databricks profile — personal access token',
        prompt: `Access token for ${host} (stored locally in ~/.databrickscfg)`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'Token cannot be empty'),
    });

    if (!token) {
        return false;
    }

    const configPath = getDatabricksConfigPath();
    let existingContent = '';
    let configFileExists = true;

    try {
        existingContent = await fsp.readFile(configPath, 'utf8');
    } catch {
        configFileExists = false;
    }

    if (configFileExists) {
        await fsp.copyFile(configPath, `${configPath}.bak`);
    }

    const sectionLines = ['', `[${profileName}]`, `host = ${host}`, `token = ${token}`];

    if (configFileExists) {
        // Drop a trailing blank run so the new section starts cleanly.
        const normalized = existingContent.replace(/\s+$/, '');
        await fsp.writeFile(
            configPath,
            `${normalized ? `${normalized}\n` : ''}${sectionLines.join('\n')}\n`,
            'utf8'
        );
    } else {
        await fsp.writeFile(
            configPath,
            `;Created by Spark Cell Runner\n${sectionLines.join('\n').replace(/^\n/, '')}\n`,
            'utf8'
        );
    }

    if (output) {
        output.appendLine(`[profiles] wrote [${profileName}] to ${configPath}${configFileExists ? ` (backup: ${configPath}.bak)` : ''}`);
    }

    return true;
}

async function createProfile(output) {
    const profiles = await listProfiles();
    const profileName = await inputProfileName(profiles.map((profile) => profile.name));

    if (!profileName) {
        return undefined;
    }

    const host = await inputHost();

    if (!host) {
        return undefined;
    }

    const authType = await vscode.window.showQuickPick(
        [
            {
                label: '$(shield) OAuth (recommended)',
                detail: 'Browser-based sign-in via the Databricks CLI; no token stored',
                value: 'oauth',
            },
            {
                label: '$(key) Personal Access Token',
                detail: 'Paste a PAT; it is saved to ~/.databrickscfg',
                value: 'token',
            },
        ],
        {
            title: `New Databricks profile: ${profileName}`,
            placeHolder: 'Select authentication method',
            ignoreFocusOut: true,
        }
    );

    if (!authType) {
        return undefined;
    }

    const created =
        authType.value === 'oauth'
            ? await createProfileWithOAuth(output, profileName, host)
            : await createProfileWithToken(output, profileName, host);

    return created ? profileName : undefined;
}

async function openDatabricksConfigFile(output) {
    const configPath = getDatabricksConfigPath();

    try {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPath));
    } catch (error) {
        void vscode.window.showErrorMessage(
            `Could not open ${configPath}: ${error instanceof Error ? error.message : String(error)}`
        );

        if (output) {
            output.appendLine(`[profiles] open ${configPath} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

module.exports = {
    PROFILE_NAME_REGEX,
    getDatabricksConfigPath,
    findDatabricksCli,
    listProfiles,
    parseCfgProfiles,
    selectProfile,
    createProfile,
    openDatabricksConfigFile,
};
