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
  let reconnectTimer;
  let reconnectAttempt = 0;
  let shouldReconnect = true;

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

  const scheduleReconnect = () => {
    if (!shouldReconnect || reconnectTimer) {
      return;
    }
    const baseDelay = 500;
    const maxDelay = 10000;
    const jitter = Math.random() * 250;
    const delay = Math.min(maxDelay, baseDelay * (2 ** reconnectAttempt)) + jitter;
    reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    try {
      socket = new WebSocket(getWebSocketUrl());
    } catch (error) {
      console.error('Failed to establish WebSocket connection:', error);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
    });

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

    socket.addEventListener('close', () => {
      scheduleReconnect();
    });
  };

  connect();

  return () => {
    shouldReconnect = false;
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  };
}
