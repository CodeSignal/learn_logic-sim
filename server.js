const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const fsp = fs.promises;
const { printCircuitReport } = require('./circuit-report');

// Try to load WebSocket module, fallback if not available
let WebSocket = null;
let isWebSocketAvailable = false;
let wss = null;
try {
  WebSocket = require('ws');
  isWebSocketAvailable = true;
  console.log('WebSocket support enabled');
} catch (error) {
  console.log('WebSocket support disabled (ws package not installed)');
  console.log('Install with: npm install ws');
}

const PORT = 3000;
const USER_VHDL_PATH = path.join(__dirname, 'user.vhdl');
const STATE_JSON_PATH = path.join(__dirname, 'state.json');
const GATE_CONFIG_PATH = path.join(__dirname, 'client', 'gate-config.json');
const INITIAL_STATE_PATH = path.join(__dirname, 'client', 'initial_state.json');
const CUSTOM_GATES_DIR = path.join(__dirname, 'client', 'custom-gates');
const CUSTOM_GATE_EXTENSIONS = new Set(['.json']);
const EXPORT_TIMEOUT_MS = 30000;

// Track connected WebSocket clients
const wsClients = new Set();
let pendingExport = null;
let lastCircuitReport = { text: '', createdAt: 0 };

// MIME types for different file extensions
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.vhdl': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Get MIME type based on file extension
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return mimeTypes[ext] || 'text/plain';
}

function createExportRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resolvePendingExport(result) {
  if (!pendingExport) {
    return;
  }
  clearTimeout(pendingExport.timeout);
  pendingExport.resolve(result);
  pendingExport = null;
}

function rejectPendingExport(error) {
  if (!pendingExport) {
    return;
  }
  clearTimeout(pendingExport.timeout);
  pendingExport.reject(error);
  pendingExport = null;
}

const slugify = (value = '', fallback = 'custom-gate') => {
  const cleaned = value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
};

const deriveAbbreviation = (label = '') => {
  const cleaned = (label || '').trim();
  if (!cleaned) {
    return 'CG';
  }
  const letters = cleaned
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
  return letters || cleaned.slice(0, 3).toUpperCase();
};

async function readFilesystemCustomGates() {
  await fsp.mkdir(CUSTOM_GATES_DIR, { recursive: true });
  const entries = await fsp.readdir(CUSTOM_GATES_DIR, { withFileTypes: true });
  const gates = [];
  const usedTypes = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!CUSTOM_GATE_EXTENSIONS.has(ext)) {
      continue;
    }
    const absolutePath = path.join(CUSTOM_GATES_DIR, entry.name);
    try {
      const contents = await fsp.readFile(absolutePath, 'utf8');
      const snapshot = JSON.parse(contents);
      const description = typeof snapshot.description === 'string' && snapshot.description.trim()
        ? snapshot.description.trim()
        : '';
      const snapshotLabel = typeof snapshot.label === 'string'
        ? snapshot.label
        : (typeof snapshot.name === 'string' ? snapshot.name : null);
      const baseName = snapshotLabel || path.basename(entry.name, ext);
      const baseSlug = slugify(baseName, 'custom-gate');
      let type = baseSlug;
      let suffix = 2;
      while (usedTypes.has(type)) {
        type = `${baseSlug}-${suffix}`;
        suffix += 1;
      }
      usedTypes.add(type);
      gates.push({
        type: `custom-${type}`,
        label: baseName,
        fileName: entry.name,
        description,
        abbreviation: deriveAbbreviation(baseName),
        snapshot
      });
    } catch (error) {
      console.warn(`Failed to parse custom gate "${entry.name}":`, error.message);
    }
  }
  return gates;
}

async function loadGateConfig() {
  try {
    const raw = await fsp.readFile(GATE_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to load gate-config.json:', error.message);
    }
    return {};
  }
}

// Serve static files
function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    const mimeType = getMimeType(filePath);
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}

// Handle POST requests
function handlePostRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/vhdl/export') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      let data;
      try {
        data = JSON.parse(body || '{}');
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { vhdl, state } = data || {};
      if (typeof vhdl !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Field "vhdl" is required' }));
        return;
      }
      if (!state || typeof state !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Field "state" must be an object' }));
        return;
      }

      try {
        await Promise.all([
          fsp.writeFile(USER_VHDL_PATH, vhdl, 'utf8'),
          fsp.writeFile(STATE_JSON_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        ]);
        try {
          const gateConfig = await loadGateConfig();
          const reportText = printCircuitReport(state, gateConfig);
          if (reportText) {
            lastCircuitReport = { text: reportText, createdAt: Date.now() };
          }
        } catch (reportError) {
          console.warn('Failed to generate export report:', reportError);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('Failed to export circuit data:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to export circuit data' }));
      }
    });
  } else if (parsedUrl.pathname === '/message') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const message = data.message;

        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message is required' }));
          return;
        }

        // Check if WebSocket is available
        if (!isWebSocketAvailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'WebSocket functionality not available',
            details: 'Install the ws package with: npm install ws'
          }));
          return;
        }

        // Broadcast message to all connected WebSocket clients
        wsClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'message', message: message }));
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, clientCount: wsClients.size }));

      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function handleCustomGateRegistryRequest(res) {
  try {
    const gates = await readFilesystemCustomGates();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gates }));
  } catch (error) {
    console.error('Failed to enumerate custom gates:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to enumerate custom gates' }));
  }
}

async function refreshInitialStateFromExport() {
  try {
    const stateContents = await fsp.readFile(STATE_JSON_PATH, 'utf8');
    await fsp.writeFile(INITIAL_STATE_PATH, stateContents, 'utf8');
    console.log('client/initial_state.json refreshed from state.json');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('state.json not found; skipping initial_state.json refresh');
    } else {
      console.error('Failed to copy state.json to client/initial_state.json:', error);
    }
  }
}

// Track open HTTP sockets so we can destroy them during shutdown
const activeHttpSockets = new Set();

// Create HTTP server
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Handle POST requests
  if (req.method === 'POST') {
    handlePostRequest(req, res);
    return;
  }
  
  // Handle GET trigger for export
  if (pathname === '/vhdl/trigger-export') {
    if (!isWebSocketAvailable) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'WebSocket functionality not available',
        details: 'Install the ws package with: npm install ws'
      }));
      return;
    }
    if (wsClients.size === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No WebSocket clients available to perform export'
      }));
      return;
    }
    if (wsClients.size > 1) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Multiple WebSocket clients connected; expected exactly one'
      }));
      return;
    }
    if (pendingExport) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'An export is already in progress'
      }));
      return;
    }

    const [client] = wsClients;
    if (!client || client.readyState !== WebSocket.OPEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'WebSocket client is not ready'
      }));
      return;
    }

    const requestId = createExportRequestId();
    const exportStartedAt = Date.now();
    const exportPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectPendingExport(new Error('Export timed out'));
      }, EXPORT_TIMEOUT_MS);
      pendingExport = { requestId, resolve, reject, timeout };
    });

    try {
      client.send(JSON.stringify({ type: 'logic-sim:export-vhdl', requestId }));
    } catch (error) {
      rejectPendingExport(error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to trigger export' }));
      return;
    }

    exportPromise
      .then((result) => {
        if (result && result.success === false) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Export failed on client',
            details: result.error || 'Unknown error'
          }));
          return;
        }
        const reportReady = lastCircuitReport.text && lastCircuitReport.createdAt >= exportStartedAt;
        const reportText = reportReady ? lastCircuitReport.text : '';
        const accepts = req.headers.accept || '';
        const wantsTextReport = parsedUrl.query?.format === 'report' || accepts.includes('text/plain');
        if (wantsTextReport && reportText) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(reportText);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Export completed via WebSocket',
          report: reportText || undefined
        }));
      })
      .catch((error) => {
        const message = error?.message || 'Unknown error';
        const isTimeout = message === 'Export timed out';
        res.writeHead(isTimeout ? 504 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: isTimeout ? 'Export timed out' : 'Export did not complete',
          details: message
        }));
      });
    return;
  }

  if (pathname === '/custom-gates/registry.json') {
    handleCustomGateRegistryRequest(res);
    return;
  }

  // Default to index.html for root path
  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Remove leading slash and construct file path
  const filePath = path.join(__dirname, 'client', pathname.substring(1));

  // Security check - prevent directory traversal
  const clientDir = path.join(__dirname, 'client');
  if (!filePath.startsWith(clientDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    // Serve the file
    serveFile(filePath, res);
  });
});

server.on('connection', (socket) => {
  activeHttpSockets.add(socket);
  socket.on('close', () => activeHttpSockets.delete(socket));
});

// Create WebSocket server only if WebSocket is available
if (isWebSocketAvailable) {
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    wsClients.add(ws);

    ws.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (error) {
        console.warn('Failed to parse WebSocket message:', error.message);
        return;
      }
      if (payload?.type === 'logic-sim:export-vhdl:done') {
        if (!pendingExport || payload.requestId !== pendingExport.requestId) {
          return;
        }
        resolvePendingExport({
          success: payload.success !== false,
          error: payload.error
        });
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      wsClients.delete(ws);
      if (pendingExport) {
        rejectPendingExport(new Error('WebSocket client disconnected'));
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      wsClients.delete(ws);
      if (pendingExport) {
        rejectPendingExport(error);
      }
    });
  });
}

async function startServer() {
  await refreshInitialStateFromExport();
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    if (isWebSocketAvailable) {
      console.log(`WebSocket server running on the same port`);
    } else {
      console.log(`WebSocket functionality disabled - install 'ws' package to enable`);
    }
    console.log(`Serving files from: ${__dirname}`);
    console.log('Press Ctrl+C to stop the server');
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please try a different port.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

let isShuttingDown = false;

function closeHttpServer() {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        console.error('Error closing HTTP server:', error);
      } else {
        console.log('HTTP server closed');
      }
      resolve();
    });
    // Force close any idle sockets so close can resolve promptly
    activeHttpSockets.forEach((socket) => {
      socket.destroy();
    });
  });
}

function closeWebSocketServer() {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }
    try {
      wss.clients.forEach((client) => {
        try {
          client.terminate();
        } catch (error) {
          console.error('Failed terminating WebSocket client:', error);
        }
      });
      wss.close(() => {
        console.log('WebSocket server closed');
        resolve();
      });
    } catch (error) {
      console.error('Error closing WebSocket server:', error);
      resolve();
    }
  });
}

async function gracefulShutdown(signal = 'SIGINT') {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\nShutting down server (${signal})...`);
  try {
    await Promise.all([closeHttpServer(), closeWebSocketServer()]);
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => gracefulShutdown(signal));
});
