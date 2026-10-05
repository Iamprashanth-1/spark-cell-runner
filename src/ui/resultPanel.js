// Webview panel showing captured run results (summary / stdout / stderr / script).

const vscode = require('vscode');

let resultPanel;

async function showRunResultPanel(payload) {
    if (!resultPanel) {
        resultPanel = vscode.window.createWebviewPanel(
            'sparkCellRunnerResults',
            'Spark Cell Runner Results',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );

        resultPanel.onDidDispose(() => {
            resultPanel = undefined;
        });
    }

    resultPanel.title = `Spark Cell Runner Result: ${payload.built.label}`;
    resultPanel.webview.html = getRunResultHtml(payload);
    resultPanel.reveal(vscode.ViewColumn.Beside, true);
}

function disposeResultPanel() {
    if (resultPanel) {
        resultPanel.dispose();
        resultPanel = undefined;
    }
}

function buildResultText(built, result, scriptPath) {
    const parts = [
        `Label: ${built.label}`,
        `Script: ${scriptPath}`,
        `Exit Code: ${result.exitCode}`,
        '',
        'STDOUT',
        result.stdout || '(empty)',
        '',
        'STDERR',
        result.stderr || '(empty)',
    ];

    return `${parts.join('\n').trimEnd()}\n`;
}

function getRunResultHtml(payload) {
    const tabs = [
        { id: 'summary', label: 'Summary', content: payload.resultText },
        {
            id: 'stdout',
            label: 'Stdout',
            content: payload.result.stdout || '(empty)'
        },
        {
            id: 'stderr',
            label: 'Stderr',
            content: payload.result.stderr || '(empty)'
        },
        {
            id: 'script',
            label: 'Script',
            content: payload.built.script
        },
    ];

    const buttons = tabs
        .map(
            (tab, index) =>
                `<button class="tab-button${index === 0 ? ' active' : ''}" data-tab="${tab.id}">${tab.label}</button>`
        )
        .join('');

    const panels = tabs
        .map(
            (tab, index) =>
                `<section id="${tab.id}" class="tab-panel${index === 0 ? ' active' : ''}"><div class="panel-bar"><span>${tab.label}</span><button type="button" class="copy-button" data-copy="${tab.id}">Copy</button></div><pre>${escapeHtml(tab.content)}</pre></section>`
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Spark Cell Runner Results</title>
<style>
:root {
    color-scheme: light dark;
    --border: color-mix(in srgb, currentColor 18%, transparent);
    --accent: var(--vscode-button-background, #0f6cbd);
    --accent-fg: var(--vscode-button-foreground, #ffffff);
    --bg-soft: color-mix(in srgb, canvas 92%, currentColor 8%);
    --ok: var(--vscode-terminal-ansiGreen, #3fb950);
    --danger: var(--vscode-terminal-ansiRed, #f85149);
    --muted: color-mix(in srgb, canvastext 55%, transparent);
}

body {
    font-family: Consolas, "Courier New", monospace;
    margin: 0;
    padding: 16px;
    background: canvas;
    color: canvastext;
}

.meta {
    display: grid;
    gap: 6px;
    margin-bottom: 14px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-soft);
}

.meta-row { display: grid; grid-template-columns: 110px 1fr; gap: 8px; align-items: baseline; }

.meta .k {
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.exit-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 1px 9px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent);
    color: var(--ok);
    font-size: 11px;
    font-weight: 700;
}

.exit-badge.failed {
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    color: var(--danger);
}

.exit-badge .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
}

.tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
}

.tab-button {
    border: 1px solid var(--border);
    background: transparent;
    color: inherit;
    padding: 6px 12px;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
}

.tab-button:hover { border-color: var(--accent); }

.tab-button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
}

.tab-panel {
    display: none;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    background: var(--bg-soft);
}

.tab-panel.active {
    display: block;
}

pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.panel-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
}

.copy-button {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 10px;
    text-transform: none;
    letter-spacing: normal;
    padding: 3px 10px;
    cursor: pointer;
}

.copy-button:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
}
</style>
</head>
<body>
<div class="meta">
        <div class="meta-row"><span class="k">Cell</span><span>${escapeHtml(payload.built.label)}</span></div>
        <div class="meta-row"><span class="k">Exit Code</span><span><span class="exit-badge${payload.result.exitCode === 0 ? '' : ' failed'}"><span class="dot"></span>${escapeHtml(String(payload.result.exitCode))}${payload.result.exitCode === 0 ? ' success' : ' failed'}</span></span></div>
        <div class="meta-row"><span class="k">Script</span><span>${escapeHtml(payload.scriptPath)}</span></div>
        <div class="meta-row"><span class="k">Output File</span><span>${escapeHtml(payload.resultPath)}</span></div>
    </div>
    <div class="tabs">${buttons}</div>
    ${panels}
    <script>
        const buttons = Array.from(document.querySelectorAll('.tab-button'));
        const panels = Array.from(document.querySelectorAll('.tab-panel'));

        for (const button of buttons) {
            button.addEventListener('click', () => {
                const id = button.getAttribute('data-tab');

                for (const candidate of buttons) {
                    candidate.classList.toggle('active', candidate === button);
                }

                for (const panel of panels) {
                    panel.classList.toggle('active', panel.id === id);
                }
            });
        }

        document.querySelectorAll('.copy-button').forEach((button) => {
            button.addEventListener('click', async () => {
                const panel = document.getElementById(button.getAttribute('data-copy'));
                const text = panel ? panel.querySelector('pre').textContent : '';
                try {
                    await navigator.clipboard.writeText(text);
                    button.textContent = 'Copied';
                } catch (error) {
                    button.textContent = 'Copy failed';
                }
                setTimeout(() => { button.textContent = 'Copy'; }, 1500);
            });
        });
    </script>
    </body>
    </html>`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = {
  showRunResultPanel,
  disposeResultPanel,
  buildResultText,
  // Exported so test/preview-ui.js can render the results panel HTML in a browser.
  getRunResultHtml,
};
