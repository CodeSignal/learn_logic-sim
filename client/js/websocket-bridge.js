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

  const sendPayload = (payload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      console.error('Failed to send WebSocket payload:', error);
    }
  };

  socket.addEventListener('message', async (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === 'logic-sim:export-vhdl' && typeof onExportRequest === 'function') {
        const requestId = payload.requestId;
        try {
          const result = await onExportRequest(payload);
          if (requestId) {
            sendPayload({
              type: 'logic-sim:export-vhdl:done',
              requestId,
              success: result !== false,
              error: result && result.error ? result.error : undefined
            });
          }
        } catch (error) {
          console.error('Failed to process export request:', error);
          if (requestId) {
            sendPayload({
              type: 'logic-sim:export-vhdl:done',
              requestId,
              success: false,
              error: error?.message || 'Export failed'
            });
          }
        }
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
