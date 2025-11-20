function getWebSocketUrl() {
  const isSecure = window.location.protocol === 'https:';
  const protocol = isSecure ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}`;
}

export function initializeWebSocketBridge({ onExportRequest } = {}) {
  if (typeof window.WebSocket !== 'function') {
    console.warn('WebSocket is not supported in this browser; export bridge disabled.');
    return null;
  }

  let socket;
  try {
    socket = new WebSocket(getWebSocketUrl());
  } catch (error) {
    console.error('Failed to establish WebSocket connection:', error);
    return null;
  }

  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === 'logic-sim:export-vhdl' && typeof onExportRequest === 'function') {
        onExportRequest();
      }
    } catch (error) {
      console.error('Failed to handle WebSocket message:', error);
    }
  });

  socket.addEventListener('error', (error) => {
    console.error('WebSocket error:', error);
  });

  return () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  };
}
