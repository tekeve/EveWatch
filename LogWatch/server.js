const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const chokidar = require('chokidar');
const { spawn } = require('child_process');

// --- CONFIGURATION ---

// [OPTIONAL] MANUAL PATH OVERRIDE
const MANUAL_LOG_DIR = 'D:\\Files\\Documents\\EVE\\logs\\Gamelogs';

// Auto-detect commonly used EVE log paths
const homeDir = os.homedir();
const possiblePaths = [
    path.join(homeDir, 'Documents', 'EVE', 'logs', 'Gamelogs'),
    path.join(homeDir, 'OneDrive', 'Documents', 'EVE', 'logs', 'Gamelogs')
];

const LOG_DIR = MANUAL_LOG_DIR || possiblePaths.find(p => fs.existsSync(p)) || possiblePaths[0];

const ENCODING = 'utf8';
const PORT = 3000;
const MAX_FILE_AGE = 24 * 60 * 60 * 1000;

// Tuning for initial load
const INITIAL_LINE_COUNT = 100;      // Only show this many lines on startup
const INITIAL_READ_BUFFER = 50 * 1024; // Read last 50KB to find those lines (safe for memory)

// --- SERVER SETUP ---

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- STATE MANAGEMENT ---

const activeFiles = new Map();
const clients = new Set();

// --- LOGIC ---

function broadcast(data) {
    const payload = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

/**
 * Attempts to bring the specific EVE window to the foreground using Windows API.
 * Uses 'AttachThreadInput' to bypass Windows foreground lock (flashing taskbar issue).
 */
function focusClientWindow(characterName) {
    if (!characterName) return;

    // Sanitize
    const cleanName = characterName.replace(/[^a-zA-Z0-9 \-_]/g, "");

    console.log(`[FOCUS] Request received for: "${cleanName}"`);

    // PowerShell Script
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

try {
    $type = Add-Type -MemberDefinition $code -Name Win32FocusHack -Namespace Win32Functions -PassThru
} catch {
    $type = [Win32Functions.Win32FocusHack]
}

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like $titlePattern } | Select-Object -First 1

if ($proc) {
    Write-Output "FOUND: '$($proc.MainWindowTitle)' (PID: $($proc.Id))"
    $hWnd = $proc.MainWindowHandle

    # Get the thread of the window that currently has focus
    $foregroundHWnd = $type::GetForegroundWindow()
    $foregroundThreadID = $type::GetWindowThreadProcessId($foregroundHWnd, [IntPtr]::Zero)
    
    # Get our own thread ID
    $currentThreadID = $type::GetCurrentThreadId()

    # Attach our input processing to the foreground window's thread
    if ($foregroundThreadID -ne $currentThreadID) {
        $type::AttachThreadInput($currentThreadID, $foregroundThreadID, $true) | Out-Null
    }

    # Force the window to the front
    $type::BringWindowToTop($hWnd) | Out-Null
    $type::ShowWindowAsync($hWnd, 9) | Out-Null # 9 = SW_RESTORE
    $type::SetForegroundWindow($hWnd) | Out-Null

    # Detach
    if ($foregroundThreadID -ne $currentThreadID) {
        $type::AttachThreadInput($currentThreadID, $foregroundThreadID, $false) | Out-Null
    }
    
    Write-Output "Focus command executed with input attachment."
} else {
    Write-Output "ERROR: No window found matching '$titlePattern'"
    $eveProcs = Get-Process | Where-Object { $_.ProcessName -eq "exefile" } 
    if ($eveProcs) {
        Write-Output "Visible EVE Clients:"
        foreach ($p in $eveProcs) {
            Write-Output " - '$($p.MainWindowTitle)'"
        }
    } else {
        Write-Output "No EVE clients (exefile) detected running."
    }
}
`;

    // Encode script to Base64 (UTF-16LE) for PowerShell -EncodedCommand
    const psScriptEncoded = Buffer.from(psScript, 'utf16le').toString('base64');

    const child = spawn('powershell.exe', ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", psScriptEncoded]);

    child.stdout.on('data', (data) => {
        console.log(`[FOCUS LOG] ${data.toString().trim()}`);
    });

    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[FOCUS ERROR] ${msg}`);
    });

    child.on('error', (err) => {
        console.error('[FOCUS FAILED] Spawn error:', err);
    });

    child.on('close', (code) => {
        if (code !== 0) console.log(`[FOCUS] Exited with code ${code}`);
    });
}

async function identifyCharacter(filePath) {
    return new Promise((resolve) => {
        const stream = fs.createReadStream(filePath, { start: 0, end: 2048, encoding: null });
        let buffer = Buffer.alloc(0);

        stream.on('data', chunk => buffer = Buffer.concat([buffer, chunk]));
        stream.on('end', () => {
            try {
                const content = buffer.toString(ENCODING);
                const match = content.match(/Listener:\s+(.*?)(\r|\n|$)/);

                if (match && match[1]) {
                    resolve(match[1].trim());
                } else {
                    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
                        const altContent = buffer.toString('utf16le');
                        const altMatch = altContent.match(/Listener:\s+(.*?)(\r|\n|$)/);
                        if (altMatch && altMatch[1]) return resolve(altMatch[1].trim());
                    }
                    resolve('Unknown');
                }
            } catch (err) {
                resolve('Unknown');
            }
        });
        stream.on('error', () => resolve('Unknown'));
    });
}

// Reads a specific chunk from a file and broadcasts it
// Used for updates (small chunks) or initial tails
function readContent(filePath, start, end) {
    const stream = fs.createReadStream(filePath, {
        start: start,
        end: end,
        encoding: null
    });

    let bufferChunks = [];
    stream.on('data', chunk => bufferChunks.push(chunk));

    stream.on('end', () => {
        const buffer = Buffer.concat(bufferChunks);
        let content = buffer.toString(ENCODING).replace(/^\uFEFF/, '');

        const fileData = activeFiles.get(filePath);
        if (fileData) {
            fileData.currentSize = end;

            if (content.trim().length > 0) {
                broadcast({
                    type: 'update',
                    character: fileData.character,
                    filename: path.basename(filePath),
                    data: content
                });
            }
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
            fileData.currentSize = 0; // File truncated/reset
        }
    });
}

async function addFileToWatch(filePath, stats) {
    if (activeFiles.has(filePath)) return;

    const age = Date.now() - stats.mtimeMs;
    if (age > MAX_FILE_AGE) return;

    const characterName = await identifyCharacter(filePath);

    // --- TAIL LOGIC ---
    // Instead of reading the whole file, we jump to the end minus a safety buffer (50KB)
    let startPosition = Math.max(0, stats.size - INITIAL_READ_BUFFER);

    // Align to 2 bytes if UTF-16LE (just in case we switch encoding later)
    if (ENCODING === 'utf16le' && startPosition % 2 !== 0) startPosition++;

    activeFiles.set(filePath, {
        character: characterName,
        currentSize: stats.size // Set currentSize to END so we don't re-read the tail later in checkFileForUpdates
    });

    console.log(`[WATCHING] ${characterName} (${path.basename(filePath)})`);

    // Manually read the tail, trim it to 100 lines, and broadcast
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
            let content = buffer.toString(ENCODING).replace(/^\uFEFF/, '');

            // Split into lines
            const lines = content.split(/\r?\n/);

            // Slice the last N lines
            const recentLines = lines.slice(-INITIAL_LINE_COUNT);
            const cleanContent = recentLines.join('\n');

            if (cleanContent.trim().length > 0) {
                broadcast({
                    type: 'update',
                    character: characterName,
                    filename: path.basename(filePath),
                    data: cleanContent
                });
            }
        });
    }

    broadcast({ type: 'info', message: `Found log: ${characterName}` });
}

// --- MAIN EXECUTION ---

if (!fs.existsSync(LOG_DIR)) {
    console.error('\n!!! ERROR: LOG DIRECTORY NOT FOUND !!!');
    console.error(`Tried: ${LOG_DIR}`);
    console.error('Please edit the "MANUAL_LOG_DIR" variable in server.js.');
} else {
    console.log(`\n--- EVE Log Watcher Started ---`);
    console.log(`Target Directory: ${LOG_DIR}`);
    console.log(`Open http://localhost:${PORT} in your browser\n`);

    const watcher = chokidar.watch(LOG_DIR, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: false
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

    wss.on('connection', (ws) => {
        clients.add(ws);

        ws.on('message', (rawMessage) => {
            try {
                const message = JSON.parse(rawMessage);
                if (message.type === 'focus' && message.character) {
                    focusClientWindow(message.character);
                }
            } catch (e) {
                console.error('Invalid WS message:', e);
            }
        });

        const activeChars = Array.from(activeFiles.values()).map(f => f.character).join(', ');
        ws.send(JSON.stringify({
            type: 'info',
            message: activeChars ? `Monitoring: ${activeChars}` : 'Scanning for logs...'
        }));

        ws.on('close', () => clients.delete(ws));
    });

    // HEARTBEAT
    setInterval(() => {
        broadcast({ type: 'ping' });
    }, 30000);

    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}