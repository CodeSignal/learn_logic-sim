const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const fsp = fs.promises;
const { printCircuitReport } = require('./circuit-report');

// Try to load WebSocket module, fallback if not available
let WebSocket = null;
let isWebSocketAvailable = false;
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

// Track connected WebSocket clients
const wsClients = new Set();

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
          printCircuitReport(state, gateConfig);
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

// Create HTTP server
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Handle POST requests
  if (req.method === 'POST') {
    handlePostRequest(req, res);
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

// Create WebSocket server only if WebSocket is available
if (isWebSocketAvailable) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    wsClients.add(ws);

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      wsClients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      wsClients.delete(ws);
    });
  });
}

// Start server
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

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please try a different port.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
