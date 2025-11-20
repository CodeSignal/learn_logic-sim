const allowedStatuses = new Set([
  'Ready',
  'Loading...',
  'Saving...',
  'Changes saved',
  'Save failed (will retry)',
  'Failed to load data',
  'Auto-save initialized'
]);

export function createStatusController(initialElement = null) {
  let statusElement = initialElement;
  let revertTimer = null;
  let lastMessage = 'Ready';

  const applyStatus = (message) => {
    lastMessage = message;
    if (statusElement) {
      statusElement.textContent = message;
    }
  };

  const setStatus = (message, options = {}) => {
    if (!allowedStatuses.has(message)) {
      console.warn(`Ignoring unsupported status message: ${message}`);
      return;
    }

    if (revertTimer) {
      window.clearTimeout(revertTimer);
      revertTimer = null;
    }

    applyStatus(message);

    if (message !== 'Ready' && typeof options.revertDelay === 'number') {
      revertTimer = window.setTimeout(() => {
        applyStatus('Ready');
        revertTimer = null;
      }, options.revertDelay);
    }
  };

  const attach = (element) => {
    statusElement = element || null;
    if (statusElement) {
      statusElement.textContent = lastMessage;
    }
  };

  return { setStatus, attach };
}
