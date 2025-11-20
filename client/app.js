import { onDocumentReady } from './js/dom-ready.js';
import { createStatusController } from './js/status-controller.js';
import { initializeHelpModal } from './js/help-loader.js';
import { initializeWebSocketBridge } from './js/websocket-bridge.js';

import './gate-registry.js';
import './logic-sim.js';

const statusController = createStatusController();
window.setStatus = statusController.setStatus;

onDocumentReady(async () => {
  statusController.attach(document.getElementById('status'));

  await initializeHelpModal({
    triggerSelector: '#btn-help',
    statusController
  });

  initializeWebSocketBridge({
    onExportRequest: () => {
      if (window.logicSim && typeof window.logicSim.exportToVhdl === 'function') {
        window.logicSim.exportToVhdl();
      }
    }
  });
});
