const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const chokidar = require('chokidar');
const { spawn } = require('child_process');

// --- CONFIGURATION ---

// Default Auto-detect paths (Targeting the PARENT 'logs' folder now)
const homeDir = os.homedir();
const possiblePaths = [
    path.join(homeDir, 'Documents', 'EVE', 'logs'),
    path.join(homeDir, 'OneDrive', 'Documents', 'EVE', 'logs')
];

// Initial setup
let LOG_DIR = possiblePaths.find(p => fs.existsSync(p)) || possiblePaths[0];

const PORT = 3000;
const MAX_FILE_AGE = 24 * 60 * 60 * 1000; // 24 hours

const INITIAL_LINE_COUNT = 100;
const INITIAL_READ_BUFFER = 50 * 1024;

// --- SERVER SETUP ---

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- STATE MANAGEMENT ---

let activeFiles = new Map();
const clients = new Set();
let watcher = null;

// --- LOGIC ---

function broadcast(data) {
    const payload = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

function focusClientWindow(characterName) {
    if (!characterName) return;
    const cleanName = characterName.replace(/[^a-zA-Z0-9 \-_]/g, "");
    console.log(`[FOCUS] Request received for: "${cleanName}"`);

    const psScript = `
$ProgressPreference = 'SilentlyContinue'
$name = "${cleanName}"
$titlePattern = "*$name*"
$code = @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
try { $type = Add-Type -MemberDefinition $code -Name Win32FocusHack -Namespace Win32Functions -PassThru } catch { $type = [Win32Functions.Win32FocusHack] }
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like $titlePattern } | Select-Object -First 1
if ($proc) {
    $hWnd = $proc.MainWindowHandle
    $foregroundHWnd = $type::GetForegroundWindow()
    $foregroundThreadID = $type::GetWindowThreadProcessId($foregroundHWnd, [IntPtr]::Zero)
    $currentThreadID = $type::GetCurrentThreadId()
    if ($foregroundThreadID -ne $currentThreadID) { $type::AttachThreadInput($currentThreadID, $foregroundThreadID, $true) | Out-Null }
    $type::BringWindowToTop($hWnd) | Out-Null
    $type::ShowWindowAsync($hWnd, 9) | Out-Null 
    $type::SetForegroundWindow($hWnd) | Out-Null
    if ($foregroundThreadID -ne $currentThreadID) { $type::AttachThreadInput($currentThreadID, $foregroundThreadID, $false) | Out-Null }
}
`;
    const psScriptEncoded = Buffer.from(psScript, 'utf16le').toString('base64');
    spawn('powershell.exe', ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", psScriptEncoded]);
}

/**
 * Reads the file header to extract Character Name, Channel Name AND Encoding
 */
async function parseLogHeader(filePath) {
    return new Promise((resolve) => {
        const stream = fs.createReadStream(filePath, { start: 0, end: 4096, encoding: null });
        let buffer = Buffer.alloc(0);

        stream.on('data', chunk => buffer = Buffer.concat([buffer, chunk]));
        stream.on('end', () => {
            try {
                // Detect Encoding
                let encoding = 'utf8';
                if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
                    encoding = 'utf16le';
                }

                // Decode
                let content = buffer.toString(encoding);

                // Extract Listener (Character)
                const listenerMatch = content.match(/Listener:\s+(.*?)(\r|\n|$)/);
                const character = (listenerMatch && listenerMatch[1]) ? listenerMatch[1].trim() : 'Unknown';

                // Extract Channel Name (Only present in Chat logs)
                const channelMatch = content.match(/Channel Name:\s+(.*?)(\r|\n|$)/);
                const channelName = (channelMatch && channelMatch[1]) ? channelMatch[1].trim() : null;

                resolve({ character, channelName, encoding });
            } catch (err) {
                resolve({ character: 'Unknown', channelName: null, encoding: 'utf8' });
            }
        });
        stream.on('error', () => resolve({ character: 'Unknown', channelName: null, encoding: 'utf8' }));
    });
}

function readContent(filePath, start, end) {
    const fileData = activeFiles.get(filePath);
    if (!fileData) return;

    const stream = fs.createReadStream(filePath, {
        start: start,
        end: end,
        encoding: null
    });

    let bufferChunks = [];
    stream.on('data', chunk => bufferChunks.push(chunk));

    stream.on('end', () => {
        const buffer = Buffer.concat(bufferChunks);
        // Use the correct encoding for this specific file
        let content = buffer.toString(fileData.encoding).replace(/^\uFEFF/, '');

        fileData.currentSize = end;
        if (content.trim().length > 0) {
            broadcast({
                type: 'update',
                kind: fileData.kind,
                character: fileData.character,
                channelName: fileData.channelName,
                filename: path.basename(filePath),
                data: content
            });
        }
    });
}

function checkFileForUpdates(filePath) {
    const fileData = activeFiles.get(filePath);
    if (!fileData) return;

    fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (stats.size > fileData.currentSize) {
            readContent(filePath, fileData.currentSize, stats.size);
        } else if (stats.size < fileData.currentSize) {
            fileData.currentSize = 0;
        }
    });
}

async function addFileToWatch(filePath, stats) {
    if (activeFiles.has(filePath)) return;

    // Check subdirectory to determine type
    const isGamelog = filePath.includes('Gamelogs');
    const isChatlog = filePath.includes('Chatlogs');

    if (!isGamelog && !isChatlog) return; // Ignore other files in logs/ root

    const age = Date.now() - stats.mtimeMs;
    if (age > MAX_FILE_AGE) return;

    const { character, channelName, encoding } = await parseLogHeader(filePath);

    const kind = isChatlog ? 'chat' : 'game';

    let startPosition = Math.max(0, stats.size - INITIAL_READ_BUFFER);
    // Align start position to 2 bytes if UTF-16LE
    if (encoding === 'utf16le' && startPosition % 2 !== 0) startPosition++;

    activeFiles.set(filePath, {
        character,
        channelName,
        kind,
        currentSize: stats.size,
        encoding
    });

    const label = kind === 'chat' ? `[CHAT: ${channelName}]` : `[GAME]`;
    console.log(`[WATCHING] ${label} ${character} (${path.basename(filePath)}) [${encoding}]`);

    if (stats.size > 0) {
        const stream = fs.createReadStream(filePath, {
            start: startPosition,
            end: stats.size,
            encoding: null
        });

        let bufferChunks = [];
        stream.on('data', chunk => bufferChunks.push(chunk));
        stream.on('end', () => {
            const buffer = Buffer.concat(bufferChunks);
            // Use detected encoding
            let content = buffer.toString(encoding).replace(/^\uFEFF/, '');
            const lines = content.split(/\r?\n/);
            const recentLines = lines.slice(-INITIAL_LINE_COUNT);
            const cleanContent = recentLines.join('\n');

            if (cleanContent.trim().length > 0) {
                broadcast({
                    type: 'update',
                    kind: kind,
                    character: character,
                    channelName: channelName,
                    filename: path.basename(filePath),
                    data: cleanContent
                });
            }
        });
    }

    broadcast({ type: 'info', message: `Found ${kind} log: ${character} ${channelName ? `(${channelName})` : ''}` });
}

function startWatching(targetDir) {
    if (watcher) {
        console.log('[SYSTEM] Stopping previous watcher...');
        watcher.close();
        activeFiles.clear();
        broadcast({ type: 'reset' });
    }

    if (!fs.existsSync(targetDir)) {
        console.error(`[ERROR] Directory not found: ${targetDir}`);
        return false;
    }

    LOG_DIR = targetDir;
    console.log(`[SYSTEM] Starting watcher on: ${LOG_DIR}`);

    // Watch recursively
    watcher = chokidar.watch(LOG_DIR, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: false,
        depth: 2,
        usePolling: true, // Force polling to ensure updates are caught on all file systems (OneDrive, etc)
        interval: 100,   // Check every 0.1 seconds
    });

    watcher
        .on('add', (filePath, stats) => {
            if (filePath.endsWith('.txt') && stats) addFileToWatch(filePath, stats);
        })
        .on('change', (filePath) => {
            if (activeFiles.has(filePath)) checkFileForUpdates(filePath);
        })
        .on('unlink', (filePath) => {
            if (activeFiles.has(filePath)) {
                activeFiles.delete(filePath);
            }
        });

    return true;
}

// --- MAIN EXECUTION ---

console.log(`\n--- EVE Log Watcher Started ---`);
startWatching(LOG_DIR);

wss.on('connection', (ws) => {
    clients.add(ws);

    ws.send(JSON.stringify({
        type: 'info',
        message: `Connected. Watching: ${LOG_DIR}`
    }));

    ws.on('message', (rawMessage) => {
        try {
            const message = JSON.parse(rawMessage);

            if (message.type === 'focus' && message.character) {
                focusClientWindow(message.character);
            }

            if (message.type === 'set-path' && message.path) {
                console.log(`[CONFIG] Path change: ${message.path}`);
                const success = startWatching(message.path);

                if (success) {
                    broadcast({ type: 'info', message: `Log path updated to: ${message.path}` });
                    ws.send(JSON.stringify({ type: 'config-success', path: message.path }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: `Directory not found: ${message.path}` }));
                }
            }

        } catch (e) {
            console.error('Invalid WS message:', e);
        }
    });

    ws.on('close', () => clients.delete(ws));
});

setInterval(() => {
    broadcast({ type: 'ping' });
}, 30000);

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});