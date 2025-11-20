import HelpModal from '../help-modal.js';

async function fetchHelpContent() {
  const response = await fetch('./help-content-template.html', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Unexpected response: ${response.status}`);
  }
  return response.text();
}

export async function initializeHelpModal({ triggerSelector = '#btn-help', statusController } = {}) {
  const setStatus = statusController?.setStatus || (() => {});
  setStatus('Loading...');

  try {
    const content = await fetchHelpContent();
    HelpModal.init({
      triggerSelector,
      content,
      theme: 'auto'
    });
    setStatus('Ready');
  } catch (error) {
    console.error('Failed to load help content:', error);
    HelpModal.init({
      triggerSelector,
      content: '<p>Help content could not be loaded. Please try again later.</p>',
      theme: 'auto'
    });
    setStatus('Failed to load data', { revertDelay: 3000 });
  }
}
