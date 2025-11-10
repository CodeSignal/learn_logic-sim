// app.js
(function() {
  const allowedStatuses = new Set([
    'Ready',
    'Loading...',
    'Saving...',
    'Changes saved',
    'Save failed (will retry)',
    'Failed to load data',
    'Auto-save initialized'
  ]);

  let statusElement = null;
  let revertTimer = null;

  const ready = (callback) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback);
    } else {
      callback();
    }
  };

  const applyStatus = (message) => {
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

  const initializeHelpModal = async () => {
    setStatus('Loading...');
    try {
      const response = await fetch('./help-content-template.html', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Unexpected response: ${response.status}`);
      }
      const helpContent = await response.text();
      HelpModal.init({
        triggerSelector: '#btn-help',
        content: helpContent,
        theme: 'auto'
      });
      setStatus('Ready');
    } catch (error) {
      console.error('Failed to load help content:', error);
      HelpModal.init({
        triggerSelector: '#btn-help',
        content: '<p>Help content could not be loaded. Please try again later.</p>',
        theme: 'auto'
      });
      setStatus('Failed to load data', { revertDelay: 2000 });
    }
  };

  const initialize = () => {
    statusElement = document.getElementById('status');
    if (!statusElement) {
      console.warn('Status element not found; status updates will be skipped.');
      return;
    }

    window.setStatus = setStatus;
    initializeHelpModal();
  };

  ready(initialize);
})();
