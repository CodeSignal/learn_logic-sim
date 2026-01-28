import { onDocumentReady } from './js/dom-ready.js';
import {
  STORAGE_KEY,
  WORKSPACE_SIZE,
  DEFAULT_SCALE,
  MIN_SCALE,
  MAX_SCALE,
  PORT_SIZE,
  GRID_SIZE,
  SAVE_DEBOUNCE,
  RETRY_DELAY,
  GATE_SCALE,
  WORLD_MIN_X,
  WORLD_MAX_X,
  WORLD_MIN_Y,
  WORLD_MAX_Y,
  COORDINATE_VERSION,
  ROTATION_STEP
} from './js/sim/constants.js';
import {
  normalizeRotation,
  getGateRotation,
  normalizeDimensions,
  rotatePoint,
  computeCustomGateDimensions,
  buildAutoPortLayout,
  worldToCanvas,
  canvasToWorld,
  worldPointToCanvas
} from './js/sim/geometry.js';
import {
  slugifyGateName,
  deriveAbbreviation,
  cloneGateTemplate,
  compileCustomGateSnapshot
} from './js/sim/custom-gate-utils.js';
import { normalizeSnapshot, flattenSnapshotForExport } from './js/sim/snapshot.js';
import { serializeSnapshotToVhdl } from './js/sim/vhdl.js';

(function() {
  const getGateDimensions = (definition) => normalizeDimensions(definition?.dimensions);

  const instantiateCustomRuntime = (compiled) => {
    const gates = new Map();
    compiled.templateGates.forEach((template, id) => {
      gates.set(id, cloneGateTemplate(template));
    });
    return {
      gates,
      connectionLookup: compiled.connectionLookup
    };
  };

  const simulateCustomRuntime = (compiled, runtime, inputValues = []) => {
    compiled.interface.inputGateIds.forEach((gateId, index) => {
      const gate = runtime.gates.get(gateId);
      if (gate) {
        gate.state = inputValues[index] ? 1 : 0;
      }
    });
    const connectionLookup = runtime.connectionLookup;
    const outputsEqual = (a, b) => {
      if (a.length !== b.length) {
        return false;
      }
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
          return false;
        }
      }
      return true;
    };
    const getInputValue = (gateId, portIndex) => {
      const key = `${gateId}:${portIndex}`;
      const from = connectionLookup.get(key);
      if (!from) {
        return 0;
      }
      const sourceGate = runtime.gates.get(from.gateId);
      if (!sourceGate) {
        return 0;
      }
      return sourceGate.outputValues[from.portIndex] ? 1 : 0;
    };
    const iterationLimit = 32;
    for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
      let changed = false;
      runtime.gates.forEach((gate) => {
        const definition = gateDefinitions[gate.type];
        if (!definition) {
          return;
        }
        const inputs = new Array(definition.inputs).fill(0).map((_, index) => getInputValue(gate.id, index));
        const previousOutputs = gate.outputValues.slice();
        gate.inputCache = inputs;
        const produced = typeof definition.logic === 'function' ? definition.logic(inputs, gate) || [] : [];
        if (definition.outputs > 0) {
          gate.outputValues = produced.map((value) => (value ? 1 : 0));
          if (!outputsEqual(previousOutputs, gate.outputValues)) {
            changed = true;
          }
        } else if (definition.allowToggle && gate.type === 'input') {
          gate.outputValues = [gate.state ? 1 : 0];
        }
      });
      if (!changed) {
        break;
      }
    }
    return compiled.interface.outputGateIds.map((gateId) => getInputValue(gateId, 0));
  };

  const snapToGrid = (value) => Math.round(value / GRID_SIZE) * GRID_SIZE;

  const registrySource = typeof window !== 'undefined' ? window.gateRegistry : null;
  if (!registrySource || !registrySource.definitions) {
    throw new Error('Gate registry is not available');
  }
  const gateDefinitions = registrySource.definitions;
  const defaultPaletteOrder = Array.isArray(registrySource.paletteOrder) && registrySource.paletteOrder.length
    ? registrySource.paletteOrder.slice()
    : Object.keys(gateDefinitions);

  onDocumentReady(async () => {
    const setStatus = typeof window.setStatus === 'function' ? window.setStatus : () => {};
    const paletteEl = document.getElementById('palette');
    const canvasEl = document.getElementById('canvas');
    const wireLayer = document.getElementById('wire-layer');
    const selectionEl = document.getElementById('selection-details');
    const clearButton = document.getElementById('btn-clear-canvas');

    if (!paletteEl || !canvasEl || !wireLayer) {
      return;
    }

    const canvasWrapper = canvasEl.parentElement;
    canvasEl.style.width = `${WORKSPACE_SIZE}px`;
    canvasEl.style.height = `${WORKSPACE_SIZE}px`;
    canvasEl.style.transformOrigin = '0 0';
    wireLayer.setAttribute('viewBox', `0 0 ${WORKSPACE_SIZE} ${WORKSPACE_SIZE}`);
    wireLayer.setAttribute('width', WORKSPACE_SIZE);
    wireLayer.setAttribute('height', WORKSPACE_SIZE);
    wireLayer.style.width = `${WORKSPACE_SIZE}px`;
    wireLayer.style.height = `${WORKSPACE_SIZE}px`;
    wireLayer.style.transformOrigin = '0 0';

    const view = {
      scale: DEFAULT_SCALE,
      offsetX: 0,
      offsetY: 0
    };

    let paletteOrder = defaultPaletteOrder.slice();
    let viewCenterOverride = null;
    let gateConfig = {};

    const state = {
      gates: new Map(),
      connections: [],
      nextId: 1
    };
    const customGateRecords = [];
    const customGateIndex = new Map();
    const gateElements = new Map();
    let selectionId = null;
    let pendingConnection = null;
    let ghostWire = null;
    let dragInfo = null;
    let panInfo = null;
    let skipClickAction = false;
    let saveTimer = null;
    let retryTimer = null;
    let exportRetryTimer = null;
    let hasLoadedState = false;
    let lastWrapperSize = { width: 0, height: 0 };
    let contextMenu = null;
    const buildSnapshotCustomGatePayload = () => customGateRecords.map((entry) => {
      const serializedVhdl = typeof entry.customVhdl === 'string' && entry.customVhdl.trim()
        ? entry.customVhdl.trim()
        : '';
      return {
        type: entry.type,
        label: entry.label,
        fileName: entry.fileName || '',
        description: entry.description || '',
        inputNames: entry.inputNames.slice(),
        outputNames: entry.outputNames.slice(),
        abbreviation: entry.abbreviation,
        customVhdl: serializedVhdl,
        source: entry.source,
        snapshot: entry.snapshot
      };
    });

    const storageSupported = (() => {
      try {
        const key = '__logic_sim_test__';
        window.localStorage.setItem(key, key);
        window.localStorage.removeItem(key);
        return true;
      } catch (error) {
        console.warn('Local storage not available:', error);
        return false;
      }
    })();

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const closeContextMenu = () => {
      if (contextMenu && contextMenu.element) {
        contextMenu.element.removeEventListener('pointerdown', stopPropagation);
        contextMenu.element.remove();
      }
      contextMenu = null;
    };

    const stopPropagation = (event) => {
      event.stopPropagation();
    };

    const loadGateConfig = async () => {
      try {
        const response = await fetch('./gate-config.json', { cache: 'no-store' });
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        gateConfig = data && typeof data === 'object' ? data : {};
        if (data && Array.isArray(data.paletteOrder)) {
          const filtered = data.paletteOrder.filter((type) => gateDefinitions[type]);
          if (filtered.length) {
            paletteOrder = filtered;
          }
        }
        if (data && typeof data.defaultZoom === 'number') {
          const clampedZoom = clamp(data.defaultZoom, MIN_SCALE, MAX_SCALE);
          view.scale = clampedZoom;
          applyViewTransform();
        }
        const centerCandidate = data?.defaultCenter;
        const hasObjectCenter = centerCandidate && typeof centerCandidate === 'object';
        const objectCenterX = hasObjectCenter ? Number(centerCandidate.x) : null;
        const objectCenterY = hasObjectCenter ? Number(centerCandidate.y) : null;
        if (hasObjectCenter && Number.isFinite(objectCenterX) && Number.isFinite(objectCenterY)) {
          viewCenterOverride = clampWorldPoint({ x: objectCenterX, y: objectCenterY });
        } else if (Number.isFinite(Number(data?.defaultCenterX)) && Number.isFinite(Number(data?.defaultCenterY))) {
          viewCenterOverride = clampWorldPoint({
            x: Number(data.defaultCenterX),
            y: Number(data.defaultCenterY)
          });
        }
      } catch (error) {
        console.warn('Failed to load gate-config.json:', error);
      }
    };

    const applyViewTransform = () => {
      const transform = `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`;
      canvasEl.style.transform = transform;
      wireLayer.style.transform = transform;
    };

    const updateWrapperSize = () => {
      const rect = canvasWrapper.getBoundingClientRect();
      if (!lastWrapperSize.width && !lastWrapperSize.height) {
        view.offsetX = rect.width / 2 - (WORKSPACE_SIZE * view.scale) / 2;
        view.offsetY = rect.height / 2 - (WORKSPACE_SIZE * view.scale) / 2;
      } else {
        const centerWorld = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const centerCanvas = worldPointToCanvas(centerWorld);
        view.offsetX = rect.width / 2 - centerCanvas.x * view.scale;
        view.offsetY = rect.height / 2 - centerCanvas.y * view.scale;
      }
      applyViewTransform();
      lastWrapperSize = { width: rect.width, height: rect.height };
    };

    const screenToWorld = (clientX, clientY) => {
      const rect = canvasWrapper.getBoundingClientRect();
      const canvasX = (clientX - rect.left - view.offsetX) / view.scale;
      const canvasY = (clientY - rect.top - view.offsetY) / view.scale;
      return {
        x: canvasToWorld(canvasX),
        y: canvasToWorld(canvasY)
      };
    };

    const worldToScreen = (worldX, worldY) => {
      const rect = canvasWrapper.getBoundingClientRect();
      const canvasX = worldToCanvas(worldX);
      const canvasY = worldToCanvas(worldY);
      return {
        x: rect.left + view.offsetX + canvasX * view.scale,
        y: rect.top + view.offsetY + canvasY * view.scale
      };
    };

    const clampWorldPoint = (point = {}) => ({
      x: clamp(Number(point.x) || 0, WORLD_MIN_X, WORLD_MAX_X),
      y: clamp(Number(point.y) || 0, WORLD_MIN_Y, WORLD_MAX_Y)
    });

    const computeBoundingBoxCenter = (gates = []) => {
      if (!gates.length) {
        return { x: 0, y: 0 };
      }
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      gates.forEach((gate) => {
        if (typeof gate.x === 'number') {
          minX = Math.min(minX, gate.x);
          maxX = Math.max(maxX, gate.x);
        }
        if (typeof gate.y === 'number') {
          minY = Math.min(minY, gate.y);
          maxY = Math.max(maxY, gate.y);
        }
      });
      if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
        return { x: 0, y: 0 };
      }
      return {
        x: clamp((minX + maxX) / 2, WORLD_MIN_X, WORLD_MAX_X),
        y: clamp((minY + maxY) / 2, WORLD_MIN_Y, WORLD_MAX_Y)
      };
    };

    const centerViewOnWorldPoint = (point = { x: 0, y: 0 }) => {
      if (!canvasWrapper) {
        return;
      }
      const rect = canvasWrapper.getBoundingClientRect();
      const target = worldPointToCanvas(clampWorldPoint(point));
      view.offsetX = rect.width / 2 - target.x * view.scale;
      view.offsetY = rect.height / 2 - target.y * view.scale;
      applyViewTransform();
    };

    const centerViewUsingSnapshot = (snapshot = {}) => {
      if (!canvasWrapper) {
        return;
      }
      if (viewCenterOverride) {
        centerViewOnWorldPoint(viewCenterOverride);
        return;
      }
      const gates = Array.isArray(snapshot.gates) && snapshot.gates.length
        ? snapshot.gates
        : Array.from(state.gates.values());
      const center = computeBoundingBoxCenter(gates);
      centerViewOnWorldPoint(center);
    };

    const scheduleRender = () => {
      renderConnections();
      state.gates.forEach((gate) => updateGateElementState(gate));
      updateSelectionPanel();
    };

    const markDirty = () => {
      if (!hasLoadedState || !storageSupported) {
        return;
      }
      if (saveTimer) {
        window.clearTimeout(saveTimer);
      }
      saveTimer = window.setTimeout(saveState, SAVE_DEBOUNCE);
    };

    const getCircuitSnapshot = () => ({
      version: COORDINATE_VERSION,
      origin: 'center',
      nextId: state.nextId,
      gates: Array.from(state.gates.values()).map((gate) => ({
        id: gate.id,
        type: gate.type,
        x: gate.x,
        y: gate.y,
        state: gate.state ?? 0,
        label: gate.label || '',
        rotation: getGateRotation(gate)
      })),
      connections: state.connections.map((connection) => ({
        id: connection.id,
        from: {
          gateId: connection.from.gateId,
          portIndex: connection.from.portIndex
        },
        to: {
          gateId: connection.to.gateId,
          portIndex: connection.to.portIndex
        }
      })),
      customGates: buildSnapshotCustomGatePayload()
    });

    const persistSnapshot = (snapshot) => {
      if (!storageSupported) {
        return;
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch (error) {
        console.warn('Failed to persist circuit snapshot:', error);
      }
    };

    
    

    const wait = (delay) => new Promise((resolve) => {
      window.setTimeout(resolve, delay);
    });

    const pruneDisconnectedSnapshot = (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.gates)) {
        return snapshot;
      }
      const outputGateIds = new Set(
        snapshot.gates.filter((gate) => gate.type === 'output').map((gate) => gate.id)
      );
      if (!outputGateIds.size) {
        return snapshot;
      }
      const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
      const predecessors = new Map();
      connections.forEach((connection) => {
        const fromId = connection?.from?.gateId;
        const toId = connection?.to?.gateId;
        if (!fromId || !toId) {
          return;
        }
        const list = predecessors.get(toId) || new Set();
        list.add(fromId);
        predecessors.set(toId, list);
      });
      const keepIds = new Set(outputGateIds);
      const stack = Array.from(outputGateIds);
      while (stack.length) {
        const gateId = stack.pop();
        const incoming = predecessors.get(gateId);
        if (!incoming) {
          continue;
        }
        incoming.forEach((sourceId) => {
          if (!keepIds.has(sourceId)) {
            keepIds.add(sourceId);
            stack.push(sourceId);
          }
        });
      }
      const gates = snapshot.gates.filter((gate) => keepIds.has(gate.id));
      const prunedConnections = connections.filter((connection) => (
        keepIds.has(connection?.from?.gateId) && keepIds.has(connection?.to?.gateId)
      ));
      return { ...snapshot, gates, connections: prunedConnections };
    };

    const applyExportOverrides = (snapshot) => {
      const exportOptions = gateConfig?.exportOptions || {};
      if (!exportOptions.zeroInputsOnExport) {
        return snapshot;
      }
      const gates = Array.isArray(snapshot.gates)
        ? snapshot.gates.map((gate) => (gate.type === 'input' ? { ...gate, state: 0 } : gate))
        : snapshot.gates;
      return { ...snapshot, gates };
    };

    const attemptExport = async () => {
      if (exportRetryTimer) {
        window.clearTimeout(exportRetryTimer);
        exportRetryTimer = null;
      }
      const originalSnapshot = getCircuitSnapshot();
      const exportSnapshot = applyExportOverrides(originalSnapshot);
      const flattenedSnapshot = flattenSnapshotForExport(exportSnapshot, gateDefinitions);
      const exportOptions = gateConfig?.exportOptions || {};
      const finalSnapshot = exportOptions.pruneDisconnected
        ? pruneDisconnectedSnapshot(flattenedSnapshot)
        : flattenedSnapshot;
      const vhdl = serializeSnapshotToVhdl(finalSnapshot, gateDefinitions, {
        sanitizeLabels: exportOptions.sanitizeLabels,
        truncateWireNames: exportOptions.truncateWireNames
      });
      try {
        setStatus('Saving...');
        const response = await fetch('/vhdl/export', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            vhdl,
            state: originalSnapshot,
            exportState: finalSnapshot
          })
        });
        if (!response.ok) {
          throw new Error(`Export failed with status ${response.status}`);
        }
        setStatus('Changes saved', { revertDelay: 1200 });
        return true;
      } catch (error) {
        console.error('Failed to export VHDL:', error);
        setStatus('Save failed (will retry)', { revertDelay: 2000 });
        return false;
      }
    };

    const exportCircuitToVhdl = async ({ waitForCompletion = false, maxAttempts = 3 } = {}) => {
      const success = await attemptExport();
      if (success) {
        return true;
      }
      if (!waitForCompletion) {
        if (!exportRetryTimer) {
          exportRetryTimer = window.setTimeout(() => {
            exportRetryTimer = null;
            exportCircuitToVhdl();
          }, RETRY_DELAY);
        }
        return false;
      }
      let attempt = 1;
      while (attempt < maxAttempts) {
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        await wait(delay);
        const retrySuccess = await attemptExport();
        if (retrySuccess) {
          return true;
        }
        attempt += 1;
      }
      return false;
    };

    const saveState = () => {
      if (saveTimer) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (!storageSupported) {
        return;
      }
      const payload = getCircuitSnapshot();

      try {
        setStatus('Saving...');
        persistSnapshot(payload);
        setStatus('Changes saved', { revertDelay: 1200 });
      } catch (error) {
        console.error('Failed to save circuit:', error);
        setStatus('Save failed (will retry)', { revertDelay: 2000 });
        if (!retryTimer) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            saveState();
          }, RETRY_DELAY);
        }
      }
    };

    const loadStarterCircuit = async ({ updateStatus = false, persist = false, showErrors = true } = {}) => {
      if (updateStatus) {
        setStatus('Loading...');
      }
      try {
        const response = await fetch('./initial_state.json', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`initial_state.json responded with ${response.status}`);
        }
        const data = await response.json();
        const snapshot = normalizeSnapshot(data) || { gates: [], connections: [], nextId: 1 };
        applyCircuitSnapshot(snapshot);
        centerViewUsingSnapshot(snapshot);
        if (persist) {
          persistSnapshot(getCircuitSnapshot());
        }
        if (updateStatus) {
          setStatus('Ready');
        }
        return true;
      } catch (error) {
        console.error('Failed to load initial_state.json:', error);
        const fallback = { gates: [], connections: [], nextId: 1 };
        applyCircuitSnapshot(fallback);
        centerViewUsingSnapshot(fallback);
        if (showErrors) {
          setStatus('Failed to load data', { revertDelay: 2000 });
        }
        return false;
      }
    };

    const loadState = async () => {
      setStatus('Loading...');
      await loadStarterCircuit({ updateStatus: false, persist: false, showErrors: false });

      if (!storageSupported) {
        hasLoadedState = true;
        setStatus('Auto-save initialized', { revertDelay: 1200 });
        return;
      }

      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          applyCircuitSnapshot(parsed);
          centerViewUsingSnapshot(parsed);
        } else {
          persistSnapshot(getCircuitSnapshot());
        }
        hasLoadedState = true;
        setStatus('Auto-save initialized', { revertDelay: 1200 });
      } catch (error) {
        console.error('Failed to load saved circuit:', error);
        persistSnapshot(getCircuitSnapshot());
        hasLoadedState = true;
        setStatus('Failed to load data', { revertDelay: 2000 });
      }
    };

    const createGateId = () => `g${state.nextId++}`;
    const createConnectionId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const restoreGate = (entry) => {
      if (!entry || !gateDefinitions[entry.type]) {
        return;
      }
      const gate = {
        id: entry.id || createGateId(),
        type: entry.type,
        x: typeof entry.x === 'number' ? entry.x : 0,
        y: typeof entry.y === 'number' ? entry.y : 0,
        state: Number(entry.state) === 1 ? 1 : 0,
        label: typeof entry.label === 'string' ? entry.label : '',
        rotation: normalizeRotation(entry.rotation),
        outputValues: new Array(gateDefinitions[entry.type].outputs).fill(0),
        inputCache: new Array(gateDefinitions[entry.type].inputs).fill(0)
      };
      gate.x = clamp(gate.x, WORLD_MIN_X, WORLD_MAX_X);
      gate.y = clamp(gate.y, WORLD_MIN_Y, WORLD_MAX_Y);
      state.gates.set(gate.id, gate);
      const definition = gateDefinitions[gate.type];
      if (definition.renderMode === 'custom-square' && definition.customCompiled) {
        gate.customRuntime = instantiateCustomRuntime(definition.customCompiled);
      }
      const element = createGateElement(gate);
      canvasEl.appendChild(element);
      gateElements.set(gate.id, element);
      positionGateElement(gate);
      updateGateLabelDisplay(gate);
    };

    const recomputeNextId = () => {
      let maxId = 0;
      state.gates.forEach((gate) => {
        const numeric = Number(String(gate.id).replace(/\D+/g, ''));
        if (!Number.isNaN(numeric)) {
          maxId = Math.max(maxId, numeric);
        }
      });
      state.nextId = Math.max(maxId + 1, 1);
    };

    const buildPalette = () => {
      paletteEl.innerHTML = '';
      paletteOrder.forEach((type) => {
        const definition = gateDefinitions[type];
        if (!definition) {
          return;
        }
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'palette-item';
        item.draggable = true;
        item.dataset.type = type;
        item.title = definition.label;

        const icon = document.createElement('span');
        icon.className = 'palette-icon';
        if (definition.icon) {
          icon.style.setProperty('--gate-icon', `url("${definition.icon}")`);
        } else {
          icon.classList.add('is-custom');
          icon.textContent = definition.customAbbreviation || deriveAbbreviation(definition.label);
        }

        const label = document.createElement('span');
        label.className = 'palette-label';
        label.textContent = definition.label;

        item.append(icon, label);

        item.addEventListener('click', () => {
          const center = getViewCenterWorld();
          addGate(type, center.x, center.y, { coordinates: 'world' });
        });

        item.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData('application/x-logic-gate', type);
          event.dataTransfer.setData('text/plain', type);
          event.dataTransfer.effectAllowed = 'copy';
        });

        paletteEl.appendChild(item);
      });
    };

    const createUniqueCustomGateType = (label) => {
      const base = `custom-${slugifyGateName(label || 'gate')}`;
      let candidate = base;
      let counter = 2;
      while (gateDefinitions[candidate]) {
        candidate = `${base}-${counter}`;
        counter += 1;
      }
      return candidate;
    };

    const createCustomGateDefinition = (entry, normalizedSnapshot) => {
      if (!normalizedSnapshot) {
        throw new Error('Custom gate snapshot is required.');
      }
      const compiled = compileCustomGateSnapshot(normalizedSnapshot, gateDefinitions);
      const logic = (inputs, gate) => {
        if (!gate.customRuntime) {
          gate.customRuntime = instantiateCustomRuntime(compiled);
        }
        return simulateCustomRuntime(compiled, gate.customRuntime, inputs);
      };
      const inputCount = compiled.interface.inputGateIds.length;
      const outputCount = compiled.interface.outputGateIds.length;
      const customDimensions = computeCustomGateDimensions(inputCount, outputCount);
      const customVhdl = typeof entry.customVhdl === 'string' && entry.customVhdl.trim()
        ? entry.customVhdl.trim()
        : '';
      const trimmedDescription = typeof entry.description === 'string' && entry.description.trim()
        ? entry.description.trim()
        : '';
      const description = trimmedDescription
        ? trimmedDescription
        : (entry.fileName
            ? `Custom gate imported from ${entry.fileName}.`
            : 'Custom gate imported from a JSON snapshot.');
      return {
        label: entry.label,
        description,
        icon: null,
        inputs: inputCount,
        outputs: outputCount,
        dimensions: customDimensions,
        portLayout: buildAutoPortLayout(inputCount, outputCount, customDimensions),
        logic,
        renderMode: 'custom-square',
        customPortLabels: {
          inputs: compiled.interface.inputNames.slice(),
          outputs: compiled.interface.outputNames.slice()
        },
        customVhdl,
        customAbbreviation: entry.abbreviation || deriveAbbreviation(entry.label),
        customSnapshot: normalizedSnapshot,
        customCompiled: compiled
      };
    };

    const registerCustomGateEntry = (entry, options = {}) => {
      if (!entry || typeof entry.label !== 'string') {
        throw new Error('Invalid custom gate metadata.');
      }
      const normalizedSource = entry.source === 'embedded'
        ? 'embedded'
        : (entry.source === 'filesystem' ? 'filesystem' : 'library');
      if (!entry.snapshot || typeof entry.snapshot !== 'object') {
        throw new Error('Custom gate snapshot is missing.');
      }
      const normalizedSnapshot = normalizeSnapshot(entry.snapshot);
      const customVhdl = typeof entry.customVhdl === 'string' && entry.customVhdl.trim()
        ? entry.customVhdl.trim()
        : '';
      const normalized = {
        type: entry.type || '',
        label: entry.label || 'Custom Gate',
        fileName: entry.fileName || '',
        description: typeof entry.description === 'string' ? entry.description.trim() : '',
        abbreviation: entry.abbreviation || deriveAbbreviation(entry.label),
        customVhdl,
        source: normalizedSource,
        snapshot: normalizedSnapshot
      };
      if (!normalized.type) {
        normalized.type = createUniqueCustomGateType(normalized.label);
      }
      const definition = createCustomGateDefinition(normalized, normalizedSnapshot);
      normalized.description = definition.description;
      normalized.inputNames = definition.customPortLabels.inputs.slice();
      normalized.outputNames = definition.customPortLabels.outputs.slice();
      normalized.customVhdl = definition.customVhdl;
      registrySource.registerGate(normalized.type, definition, { addToPalette: false });
      if (!paletteOrder.includes(normalized.type)) {
        paletteOrder.push(normalized.type);
      }
      if (options.rebuildPalette !== false) {
        buildPalette();
      }
      customGateIndex.set(normalized.type, normalized);
      const existingIndex = customGateRecords.findIndex((gate) => gate.type === normalized.type);
      if (existingIndex >= 0) {
        customGateRecords[existingIndex] = normalized;
      } else {
        customGateRecords.push(normalized);
      }
      if (options.markDirty) {
        markDirty();
      }
      return normalized;
    };

    const hydrateSnapshotCustomGates = (snapshot = {}) => {
      if (!snapshot || !Array.isArray(snapshot.customGates)) {
        return;
      }
      snapshot.customGates.forEach((entry) => {
        if (!entry?.type || customGateIndex.has(entry.type)) {
          return;
        }
        try {
          registerCustomGateEntry(
            {
              ...entry,
              customVhdl: typeof entry.customVhdl === 'string' && entry.customVhdl.trim()
                ? entry.customVhdl.trim()
                : '',
              source: entry.source === 'library' ? 'library' : (entry.source === 'filesystem' ? 'filesystem' : 'embedded')
            },
            { rebuildPalette: false }
          );
        } catch (error) {
          console.warn('Failed to hydrate custom gate:', error);
        }
      });
    };

    const loadFilesystemCustomGates = async () => {
      try {
        const response = await fetch('./custom-gates/registry.json', { cache: 'no-store' });
        if (!response.ok) {
          if (response.status !== 404) {
            console.warn(`Failed to fetch filesystem custom gates: ${response.status}`);
          }
          return;
        }
        const payload = await response.json();
        if (Array.isArray(payload?.gates)) {
          payload.gates.forEach((entry) => {
            if (!entry?.type) {
              return;
            }
            try {
              registerCustomGateEntry(
                {
                  type: entry.type,
                  label: entry.label,
                  fileName: entry.fileName,
                  description: entry.description,
                  abbreviation: entry.abbreviation,
                  customVhdl: typeof entry.customVhdl === 'string' && entry.customVhdl.trim()
                    ? entry.customVhdl.trim()
                    : '',
                  source: 'filesystem',
                  snapshot: entry.snapshot
                },
                { rebuildPalette: false }
              );
            } catch (error) {
              console.warn(`Skipping filesystem gate "${entry?.label || entry.type}":`, error);
            }
          });
        }
      } catch (error) {
        console.warn('Failed to load filesystem custom gates:', error);
      }
    };

    const getViewCenterWorld = () => {
      const rect = canvasWrapper.getBoundingClientRect();
      return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    };

    const addGate = (type, posX, posY, options = { coordinates: 'screen' }) => {
      const definition = gateDefinitions[type];
      if (!definition) {
        return;
      }
      const worldPoint = options.coordinates === 'world'
        ? { x: posX, y: posY }
        : screenToWorld(posX, posY);

      const { width: gateWidth, height: gateHeight } = getGateDimensions(definition);
      const gate = {
        id: createGateId(),
        type,
        x: snapToGrid(worldPoint.x - gateWidth / 2),
        y: snapToGrid(worldPoint.y - gateHeight / 2),
        state: type === 'input' ? 0 : 0,
        label: '',
        rotation: 0,
        outputValues: new Array(definition.outputs).fill(0),
        inputCache: new Array(definition.inputs).fill(0)
      };

      gate.x = clamp(gate.x, WORLD_MIN_X, WORLD_MAX_X);
      gate.y = clamp(gate.y, WORLD_MIN_Y, WORLD_MAX_Y);

      state.gates.set(gate.id, gate);
      if (definition.renderMode === 'custom-square' && definition.customCompiled) {
        gate.customRuntime = instantiateCustomRuntime(definition.customCompiled);
      }
      const element = createGateElement(gate);
      canvasEl.appendChild(element);
      gateElements.set(gate.id, element);
      positionGateElement(gate);
      updateGateLabelDisplay(gate);
      selectGate(gate.id);
      evaluateCircuit(true);
      scheduleRender();
      markDirty();
    };

    const runGateAction = (gate, actionId) => {
      const definition = gateDefinitions[gate.type];
      if (!definition || !Array.isArray(definition.actions)) {
        return false;
      }
      const action = definition.actions.find((candidate) => candidate.id === actionId);
      if (!action) {
        return false;
      }
      action.perform({
        gate,
        evaluateCircuit,
        scheduleRender,
        markDirty,
        refreshSelection: () => updateSelectionPanel()
      });
      return true;
    };

    const createGateIcon = (definition) => {
      const icon = document.createElement('div');
      icon.className = 'gate-icon';
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', `${definition.label} gate`);
      icon.style.setProperty('--gate-icon', `url("${definition.icon}")`);
      return icon;
    };

    const createCustomGateSurface = (definition, gate) => {
      const surface = document.createElement('div');
      surface.className = 'gate-custom';
      surface.setAttribute('role', 'img');
      surface.setAttribute('aria-label', `${definition.label} custom gate`);
      const name = document.createElement('span');
      name.className = 'gate-custom-name';
      name.textContent = (gate.label || definition.label || 'Custom').slice(0, 20);
      surface.appendChild(name);
      return surface;
    };

    const createGateElement = (gate) => {
      const definition = gateDefinitions[gate.type];
      const element = document.createElement('div');
      element.className = `gate gate-${gate.type}`;
      element.dataset.id = gate.id;
      element.title = definition.label;
      element.style.setProperty('--gate-color', 'var(--logic-gate-base)');
      const { width, height } = getGateDimensions(definition);
      element.style.setProperty('--gate-width', `${width}px`);
      element.style.setProperty('--gate-height', `${height}px`);

      const surface = document.createElement('div');
      surface.className = 'gate-surface';
      element.appendChild(surface);

      const visual = definition.renderMode === 'custom-square'
        ? createCustomGateSurface(definition, gate)
        : createGateIcon(definition);
      surface.appendChild(visual);

      const nameTag = document.createElement('div');
      nameTag.className = 'gate-label';
      element.appendChild(nameTag);

      for (let i = 0; i < definition.inputs; i += 1) {
        surface.appendChild(createPort('input', gate.id, i, definition, surface));
      }
      for (let i = 0; i < definition.outputs; i += 1) {
        surface.appendChild(createPort('output', gate.id, i, definition, surface));
      }
      surface.style.transform = `rotate(${getGateRotation(gate)}deg)`;

      element.addEventListener('click', (event) => {
        if (event.target.closest('.port')) {
          return;
        }
        if (skipClickAction) {
          skipClickAction = false;
          return;
        }
        selectGate(gate.id);
        if (definition.primaryAction) {
          runGateAction(gate, definition.primaryAction);
        }
      });

      element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        selectGate(gate.id);
        openContextMenu(gate, event);
      });

      element.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('.port')) {
          return;
        }
        event.preventDefault();
        closeContextMenu();
        selectGate(gate.id);
        startDrag(event, gate.id);
      });

      return element;
    };

    const createPort = (kind, gateId, index, definition, hostElement) => {
      const port = document.createElement('button');
      port.type = 'button';
      port.className = `port ${kind}`;
      port.dataset.portType = kind;
      port.dataset.index = String(index);
      port.title = `${kind === 'input' ? 'Input' : 'Output'} ${index + 1}`;
      const positions = definition.portLayout?.[kind === 'input' ? 'inputs' : 'outputs'] || [];
      const coordinates = positions[index];
      if (coordinates) {
        port.style.left = `${coordinates.x * GATE_SCALE - PORT_SIZE / 2}px`;
        port.style.top = `${coordinates.y * GATE_SCALE - PORT_SIZE / 2}px`;
        if (hostElement && definition.renderMode === 'custom-square') {
          const labels = definition.customPortLabels?.[kind === 'input' ? 'inputs' : 'outputs'];
          const labelText = Array.isArray(labels) ? labels[index] : null;
          if (labelText) {
            const label = document.createElement('span');
            label.className = `port-label ${kind}`;
            label.textContent = labelText;
            label.style.left = `${coordinates.x * GATE_SCALE}px`;
            label.style.top = `${coordinates.y * GATE_SCALE}px`;
            hostElement.appendChild(label);
          }
        }
      }
      port.addEventListener('click', (event) => handlePortClick(event, gateId));
      return port;
    };

    const positionGateElement = (gate) => {
      const element = gateElements.get(gate.id);
      if (!element) {
        return;
      }
      element.style.left = `${worldToCanvas(gate.x)}px`;
      element.style.top = `${worldToCanvas(gate.y)}px`;
    };

    const applyGateRotation = (gate) => {
      const element = gateElements.get(gate.id);
      if (!element) {
        return;
      }
      const surface = element.querySelector('.gate-surface');
      if (!surface) {
        return;
      }
      surface.style.transform = `rotate(${getGateRotation(gate)}deg)`;
    };

    const selectGate = (gateId) => {
      if (selectionId === gateId) {
        return;
      }
      if (selectionId) {
        const previous = gateElements.get(selectionId);
        if (previous) {
          previous.classList.remove('is-selected');
        }
      }
      selectionId = gateId;
      if (selectionId) {
        const current = gateElements.get(selectionId);
        if (current) {
          current.classList.add('is-selected');
        }
      }
      updateSelectionPanel();
    };

    const updateSelectionPanel = () => {
      if (!selectionEl) {
        return;
      }
      selectionEl.innerHTML = '';
      if (!selectionId) {
        const placeholder = document.createElement('p');
        placeholder.textContent = 'No component selected';
        selectionEl.appendChild(placeholder);
        return;
      }
      const gate = state.gates.get(selectionId);
      if (!gate) {
        const placeholder = document.createElement('p');
        placeholder.textContent = 'No component selected';
        selectionEl.appendChild(placeholder);
        return;
      }

      const definition = gateDefinitions[gate.type];
      const inputs = gate.inputCache || [];
      const outputs = gate.outputValues || [];

      const title = document.createElement('h3');
      title.textContent = definition.label;
      selectionEl.appendChild(title);

      const description = document.createElement('p');
      description.textContent = definition.description;
      selectionEl.appendChild(description);

      const stats = document.createElement('dl');

      const inputsTerm = document.createElement('dt');
      inputsTerm.textContent = 'Inputs';
      stats.appendChild(inputsTerm);
      const inputsDesc = document.createElement('dd');
      inputsDesc.textContent = definition.inputs
        ? inputs.map((value, index) => `In ${index + 1}: ${value ? '1' : '0'}`).join(', ')
        : 'None';
      stats.appendChild(inputsDesc);

      const outputsTerm = document.createElement('dt');
      outputsTerm.textContent = 'Outputs';
      stats.appendChild(outputsTerm);
      const outputsDesc = document.createElement('dd');
      outputsDesc.textContent = definition.outputs
        ? outputs.map((value, index) => `Out ${index + 1}: ${value ? '1' : '0'}`).join(', ')
        : `State: ${gate.state ? '1' : '0'}`;
      stats.appendChild(outputsDesc);

      const positionTerm = document.createElement('dt');
      positionTerm.textContent = 'Position';
      stats.appendChild(positionTerm);
      const positionDesc = document.createElement('dd');
      positionDesc.textContent = `${Math.round(gate.x)}, ${Math.round(gate.y)}`;
      stats.appendChild(positionDesc);

      selectionEl.appendChild(stats);

      if (definition.supportsLabel) {
        const nameTerm = document.createElement('dt');
        nameTerm.textContent = 'Name';
        stats.appendChild(nameTerm);
        const nameDesc = document.createElement('dd');
        nameDesc.textContent = gate.label ? gate.label : '—';
        stats.appendChild(nameDesc);
      }

      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'selection-actions';

      const availableActions = Array.isArray(definition.actions) ? definition.actions : [];
      availableActions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'as-button';
        button.textContent = action.label;
        button.addEventListener('click', () => {
          runGateAction(gate, action.id);
        });
        actionsContainer.appendChild(button);
      });

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'as-button danger';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => removeGate(gate.id));
      actionsContainer.appendChild(removeButton);

      selectionEl.appendChild(actionsContainer);
    };

    const updateGateLabelDisplay = (gate) => {
      const element = gateElements.get(gate.id);
      if (!element) {
        return;
      }
      const labelEl = element.querySelector('.gate-label');
      if (!labelEl) {
        return;
      }
      const text = (gate.label || '').trim();
      labelEl.textContent = text;
      labelEl.classList.toggle('is-visible', Boolean(text));
    };

    const positionContextMenu = (menu, gate, anchorEvent) => {
      const gateElement = gateElements.get(gate.id);
      let anchorX;
      let anchorY;
      let fallbackRect = null;
      if (gateElement) {
        fallbackRect = gateElement.getBoundingClientRect();
        anchorX = fallbackRect.left + fallbackRect.width / 2;
        anchorY = fallbackRect.top;
      }
      if (anchorEvent && typeof anchorEvent.clientX === 'number' && typeof anchorEvent.clientY === 'number') {
        anchorX = anchorEvent.clientX;
        anchorY = anchorEvent.clientY;
      }
      anchorX = typeof anchorX === 'number' ? anchorX : window.innerWidth / 2;
      anchorY = typeof anchorY === 'number' ? anchorY : window.innerHeight / 2;

      requestAnimationFrame(() => {
        const menuRect = menu.getBoundingClientRect();
        let left = anchorX - menuRect.width / 2;
        let top = anchorY - menuRect.height - 12;

        if (fallbackRect && top < 12) {
          top = fallbackRect.bottom + 12;
        }
        left = clamp(left, 12, Math.max(12, window.innerWidth - menuRect.width - 12));
        top = clamp(top, 12, Math.max(12, window.innerHeight - menuRect.height - 12));

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
      });
    };

    const openContextMenu = (gate, anchorEvent) => {
      const definition = gateDefinitions[gate.type];
      if (!definition) {
        return;
      }
      closeContextMenu();

      const menu = document.createElement('div');
      menu.className = 'gate-context-menu';
      menu.dataset.gateId = gate.id;

      const heading = document.createElement('h4');
      heading.textContent = definition.label;
      menu.appendChild(heading);

      if (definition.description) {
        const description = document.createElement('p');
        description.className = 'menu-description';
        description.textContent = definition.description;
        menu.appendChild(description);
      }

      if (definition.supportsLabel) {
        const field = document.createElement('label');
        field.className = 'menu-field';
        const caption = document.createElement('span');
        caption.textContent = 'Name';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = gate.label || '';
        input.placeholder = 'Optional label';
        input.addEventListener('input', () => {
          gate.label = input.value.slice(0, 32);
          updateGateLabelDisplay(gate);
          updateSelectionPanel();
          markDirty();
        });
        field.append(caption, input);
        menu.appendChild(field);

        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      }

      const actions = Array.isArray(definition.actions) ? definition.actions : [];
      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'menu-actions';

      actions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'as-button';
        button.textContent = action.label;
        button.addEventListener('click', () => {
          runGateAction(gate, action.id);
          updateSelectionPanel();
        });
        actionsContainer.appendChild(button);
      });

      const rotateButton = document.createElement('button');
      rotateButton.type = 'button';
      rotateButton.className = 'as-button icon-button';
      rotateButton.setAttribute('aria-label', 'Rotate gate clockwise');
      const rotateIcon = document.createElement('img');
      rotateIcon.src = './resources/rotate.svg';
      rotateIcon.alt = '';
      rotateIcon.setAttribute('aria-hidden', 'true');
      rotateButton.appendChild(rotateIcon);
      rotateButton.addEventListener('click', () => {
        rotateGateClockwise(gate.id);
        updateSelectionPanel();
      });
      actionsContainer.appendChild(rotateButton);

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'as-button danger';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => {
        removeGate(gate.id);
        closeContextMenu();
      });
      actionsContainer.appendChild(removeButton);

      menu.appendChild(actionsContainer);

      menu.addEventListener('pointerdown', stopPropagation);
      menu.addEventListener('contextmenu', (event) => event.preventDefault());
      document.body.appendChild(menu);
      contextMenu = { element: menu, gateId: gate.id };

      positionContextMenu(menu, gate, anchorEvent);
    };

    const handleGlobalPointerDown = (event) => {
      if (!contextMenu) {
        return;
      }
      if (event.button === 2) {
        return;
      }
      if (contextMenu.element && contextMenu.element.contains(event.target)) {
        return;
      }
      closeContextMenu();
    };

    const removeGate = (gateId) => {
      if (!state.gates.has(gateId)) {
        return;
      }
      if (contextMenu && contextMenu.gateId === gateId) {
        closeContextMenu();
      }
      const element = gateElements.get(gateId);
      if (element) {
        element.remove();
      }
      gateElements.delete(gateId);
      state.gates.delete(gateId);
      state.connections = state.connections.filter((connection) =>
        connection.from.gateId !== gateId && connection.to.gateId !== gateId
      );
      if (selectionId === gateId) {
        selectionId = null;
      }
      evaluateCircuit(true);
      scheduleRender();
      markDirty();
    };

    const rotateGateClockwise = (gateId) => {
      const gate = state.gates.get(gateId);
      if (!gate) {
        return;
      }
      gate.rotation = normalizeRotation(getGateRotation(gate) + ROTATION_STEP);
      applyGateRotation(gate);
      renderConnections();
      markDirty();
    };

    const startDrag = (event, gateId) => {
      const gate = state.gates.get(gateId);
      if (!gate) {
        return;
      }
      closeContextMenu();
      const pointerWorld = screenToWorld(event.clientX, event.clientY);
      dragInfo = {
        gateId,
        offsetX: pointerWorld.x - gate.x,
        offsetY: pointerWorld.y - gate.y
      };
      skipClickAction = false;
      const element = gateElements.get(gateId);
      if (element) {
        element.classList.add('is-dragging');
      }
      window.addEventListener('pointermove', handleDragMove);
      window.addEventListener('pointerup', handleDragEnd, { once: true });
      window.addEventListener('pointercancel', handleDragEnd, { once: true });
    };

    const handleDragMove = (event) => {
      if (!dragInfo) {
        return;
      }
      const gate = state.gates.get(dragInfo.gateId);
      if (!gate) {
        return;
      }
      const pointerWorld = screenToWorld(event.clientX, event.clientY);
      gate.x = pointerWorld.x - dragInfo.offsetX;
      gate.y = pointerWorld.y - dragInfo.offsetY;
      skipClickAction = true;
      positionGateElement(gate);
      renderConnections();
    };

    const handleDragEnd = () => {
      if (!dragInfo) {
        return;
      }
      const { gateId } = dragInfo;
      const element = gateElements.get(gateId);
      if (element) {
        element.classList.remove('is-dragging');
      }
      const gate = state.gates.get(gateId);
      if (gate) {
        gate.x = clamp(snapToGrid(gate.x), WORLD_MIN_X, WORLD_MAX_X);
        gate.y = clamp(snapToGrid(gate.y), WORLD_MIN_Y, WORLD_MAX_Y);
        positionGateElement(gate);
      }
      dragInfo = null;
      window.removeEventListener('pointermove', handleDragMove);
      renderConnections();
      markDirty();
    };

    const removeConnectionTo = (gateId, portIndex) => {
      const originalLength = state.connections.length;
      state.connections = state.connections.filter((connection) =>
        !(connection.to.gateId === gateId && connection.to.portIndex === portIndex)
      );
      return state.connections.length !== originalLength;
    };

    const handlePortClick = (event, gateId) => {
      event.stopPropagation();
      closeContextMenu();
      const port = event.currentTarget;
      const portIndex = Number(port.dataset.index);
      const portType = port.dataset.portType;

      if (portType === 'output') {
        if (pendingConnection && pendingConnection.gateId === gateId && pendingConnection.portIndex === portIndex) {
          cancelPendingConnection();
          return;
        }
        cancelPendingConnection();
        pendingConnection = { gateId, portIndex, element: port };
        port.classList.add('is-active');
        canvasEl.classList.add('is-connecting');
        startGhostWire(event);
        return;
      }

      if (portType === 'input') {
        if (!pendingConnection) {
          const removed = removeConnectionTo(gateId, portIndex);
          if (removed) {
            renderConnections();
            markDirty();
          }
          return;
        }
        if (pendingConnection.gateId === gateId) {
          cancelPendingConnection();
          return;
        }
        createConnection(pendingConnection, { gateId, portIndex });
        cancelPendingConnection();
        evaluateCircuit(true);
        scheduleRender();
        markDirty();
      }
    };

    const cancelPendingConnection = () => {
      if (pendingConnection && pendingConnection.element) {
        pendingConnection.element.classList.remove('is-active');
      }
      pendingConnection = null;
      canvasEl.classList.remove('is-connecting');
      removeGhostWire();
    };

    const clearCircuit = () => {
      cancelPendingConnection();
      closeContextMenu();
      state.gates.clear();
      gateElements.forEach((element) => element.remove());
      gateElements.clear();
      state.connections = [];
      selectionId = null;
    };

    const applyCircuitSnapshot = (snapshot = {}, options = {}) => {
      hydrateSnapshotCustomGates(snapshot);
      clearCircuit();
      const gates = Array.isArray(snapshot.gates) ? snapshot.gates : [];
      gates.forEach((entry) => restoreGate(entry));
      const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
      state.connections = connections.map((connection) => ({
        id: connection.id || createConnectionId(),
        from: {
          gateId: connection.from?.gateId,
          portIndex: Number(connection.from?.portIndex)
        },
        to: {
          gateId: connection.to?.gateId,
          portIndex: Number(connection.to?.portIndex)
        }
      })).filter((connection) =>
        state.gates.has(connection.from.gateId) &&
        state.gates.has(connection.to.gateId) &&
        !Number.isNaN(connection.from.portIndex) &&
        !Number.isNaN(connection.to.portIndex)
      );

      const explicitNextId = Number(snapshot.nextId);
      if (!Number.isNaN(explicitNextId) && explicitNextId > 0) {
        state.nextId = explicitNextId;
      } else {
        recomputeNextId();
      }

      if (options.evaluate !== false) {
        evaluateCircuit(false);
        scheduleRender();
      }
    };

    const resetToStarter = async () => {
      setStatus('Loading...');
      closeContextMenu();
      const ok = await loadStarterCircuit({ updateStatus: false, persist: false, showErrors: true });
      if (!ok) {
        return;
      }
      hasLoadedState = true;
      if (storageSupported) {
        const snapshot = getCircuitSnapshot();
        setStatus('Saving...');
        persistSnapshot(snapshot);
        setStatus('Changes saved', { revertDelay: 1200 });
      } else {
        setStatus('Ready');
      }
    };

    const createConnection = (from, to) => {
      removeConnectionTo(to.gateId, to.portIndex);
      const connection = {
        id: createConnectionId(),
        from: { gateId: from.gateId, portIndex: from.portIndex },
        to: { gateId: to.gateId, portIndex: to.portIndex }
      };
      state.connections.push(connection);
      renderConnections();
    };

    const getPortWorldPosition = (gateId, portIndex, kind) => {
      const gate = state.gates.get(gateId);
      if (!gate) {
        return null;
      }
      const definition = gateDefinitions[gate.type];
      const positions = definition.portLayout?.[kind === 'input' ? 'inputs' : 'outputs'];
      if (!positions || !positions[portIndex]) {
        return null;
      }
      const coordinates = rotatePoint(
        positions[portIndex],
        getGateRotation(gate),
        getGateDimensions(definition)
      );
      return {
        x: worldToCanvas(gate.x) + coordinates.x * GATE_SCALE,
        y: worldToCanvas(gate.y) + coordinates.y * GATE_SCALE
      };
    };

    const getInputValue = (gateId, portIndex) => {
      const connection = state.connections.find((value) =>
        value.to.gateId === gateId && value.to.portIndex === portIndex
      );
      if (!connection) {
        return 0;
      }
      const sourceGate = state.gates.get(connection.from.gateId);
      if (!sourceGate) {
        return 0;
      }
      return sourceGate.outputValues?.[connection.from.portIndex] ? 1 : 0;
    };

    const evaluateCircuit = (triggeredByUser = false) => {
      const iterationLimit = 16;
      let changed = false;

      for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
        changed = false;
        state.gates.forEach((gate) => {
          const definition = gateDefinitions[gate.type];
          const inputs = new Array(definition.inputs).fill(0).map((_, index) => getInputValue(gate.id, index));
          const previousOutputs = gate.outputValues.slice();
          gate.inputCache = inputs;
          const produced = typeof definition.logic === 'function' ? definition.logic(inputs, gate) || [] : [];
          if (definition.outputs > 0) {
            gate.outputValues = produced.map((value) => (value ? 1 : 0));
          }
          if (definition.allowToggle && definition.outputs === 0) {
            gate.outputValues = [gate.state ? 1 : 0];
          }
          if (definition.outputs > 0 && !arraysEqual(previousOutputs, gate.outputValues)) {
            changed = true;
          }
        });
        if (!changed) {
          break;
        }
      }

      state.gates.forEach((gate) => updateGateElementState(gate));
      if (triggeredByUser) {
        renderConnections();
      }
    };

    const arraysEqual = (a, b) => {
      if (a.length !== b.length) {
        return false;
      }
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
          return false;
        }
      }
      return true;
    };

    const updateGateElementState = (gate) => {
      const element = gateElements.get(gate.id);
      if (!element) {
        return;
      }
      const definition = gateDefinitions[gate.type];
      const isHigh = definition.outputs ? gate.outputValues.some(Boolean) : Boolean(gate.state);
      element.classList.toggle('is-high', isHigh);
      element.style.setProperty('--gate-color', isHigh ? 'var(--logic-gate-active)' : 'var(--logic-gate-base)');

      element.querySelectorAll('.port.output').forEach((port) => {
        const index = Number(port.dataset.index);
        const value = gate.outputValues[index] ? 1 : 0;
        port.classList.toggle('is-active', Boolean(value));
      });

      element.querySelectorAll('.port.input').forEach((port) => {
        const index = Number(port.dataset.index);
        const value = gate.inputCache?.[index] ? 1 : 0;
        port.classList.toggle('is-active', Boolean(value));
      });

      updateGateLabelDisplay(gate);
      applyGateRotation(gate);
    };

    const renderConnections = () => {
      wireLayer.querySelectorAll('[data-wire-type="connection"]').forEach((node) => node.remove());
      state.connections.forEach((connection) => {
        const from = getPortWorldPosition(connection.from.gateId, connection.from.portIndex, 'output');
        const to = getPortWorldPosition(connection.to.gateId, connection.to.portIndex, 'input');
        if (!from || !to) {
          return;
        }
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', buildWirePath(from, to));
        const sourceGate = state.gates.get(connection.from.gateId);
        const isActive = sourceGate?.outputValues?.[connection.from.portIndex] === 1;
        path.setAttribute('class', `wire${isActive ? ' is-active' : ''}`);
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        path.dataset.wireType = 'connection';
        wireLayer.appendChild(path);
      });
    };

    const buildWirePath = (from, to) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        const direction = dx === 0 ? 1 : Math.sign(dx);
        const offset = Math.max(40, Math.abs(dx) / 2);
        const control1X = from.x + offset * direction;
        const control2X = to.x - offset * direction;
        return `M ${from.x} ${from.y} C ${control1X} ${from.y}, ${control2X} ${to.y}, ${to.x} ${to.y}`;
      }
      const direction = dy === 0 ? 1 : Math.sign(dy);
      const offset = Math.max(40, Math.abs(dy) / 2);
      const control1Y = from.y + offset * direction;
      const control2Y = to.y - offset * direction;
      return `M ${from.x} ${from.y} C ${from.x} ${control1Y}, ${to.x} ${control2Y}, ${to.x} ${to.y}`;
    };

    const updateGhostWireFromPoint = (clientX, clientY) => {
      if (!ghostWire || !pendingConnection || typeof clientX !== 'number' || typeof clientY !== 'number') {
        return;
      }
      const from = getPortWorldPosition(pendingConnection.gateId, pendingConnection.portIndex, 'output');
      if (!from) {
        removeGhostWire();
        return;
      }
      const pointerWorld = screenToWorld(clientX, clientY);
      const pointerCanvas = worldPointToCanvas(pointerWorld);
      ghostWire.setAttribute('d', buildWirePath(from, pointerCanvas));
    };

    const handleGhostPointerMove = (event) => {
      updateGhostWireFromPoint(event.clientX, event.clientY);
    };

    const startGhostWire = (event) => {
      removeGhostWire();
      ghostWire = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      ghostWire.setAttribute('class', 'wire wire-ghost');
      ghostWire.setAttribute('vector-effect', 'non-scaling-stroke');
      ghostWire.dataset.wireType = 'ghost';
      wireLayer.appendChild(ghostWire);
      window.addEventListener('pointermove', handleGhostPointerMove);
      const hasPointerCoordinates = Boolean(
        event &&
        typeof event.clientX === 'number' &&
        typeof event.clientY === 'number' &&
        !(event.type === 'click' && event.detail === 0)
      );
      if (hasPointerCoordinates) {
        updateGhostWireFromPoint(event.clientX, event.clientY);
      }
    };

    const removeGhostWire = () => {
      if (ghostWire) {
        ghostWire.remove();
        ghostWire = null;
      }
      window.removeEventListener('pointermove', handleGhostPointerMove);
    };

    const handleCanvasDrop = (event) => {
      event.preventDefault();
      closeContextMenu();
      const type = event.dataTransfer.getData('application/x-logic-gate') || event.dataTransfer.getData('text/plain');
      if (!gateDefinitions[type]) {
        return;
      }
      const pointerWorld = screenToWorld(event.clientX, event.clientY);
      addGate(type, pointerWorld.x, pointerWorld.y, { coordinates: 'world' });
    };

    const handleCanvasClick = (event) => {
      closeContextMenu();
      if (event.target === canvasEl) {
        selectGate(null);
        cancelPendingConnection();
      }
    };

    const handleKeyDown = (event) => {
      const active = document.activeElement;
      if (contextMenu && contextMenu.element && contextMenu.element.contains(active)) {
        if (event.key === 'Escape') {
          closeContextMenu();
          return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          return;
        }
      }

      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          return;
        }
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectionId) {
        event.preventDefault();
        removeGate(selectionId);
        return;
      }
      if (event.key === 'Escape') {
        cancelPendingConnection();
        closeContextMenu();
      }
    };

    const handlePanPointerDown = (event) => {
      if (event.button !== 0) {
        return;
      }
      if (event.target.closest('.gate') || event.target.closest('.port')) {
        return;
      }
      event.preventDefault();
      canvasWrapper.setPointerCapture(event.pointerId);
      closeContextMenu();
      panInfo = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: view.offsetX,
        offsetY: view.offsetY
      };
    };

    const handlePanPointerMove = (event) => {
      if (!panInfo || event.pointerId !== panInfo.pointerId) {
        return;
      }
      view.offsetX = panInfo.offsetX + (event.clientX - panInfo.startX);
      view.offsetY = panInfo.offsetY + (event.clientY - panInfo.startY);
      applyViewTransform();
      updateGhostWireFromPoint(event.clientX, event.clientY);
    };

    const handlePanPointerUp = (event) => {
      if (!panInfo || event.pointerId !== panInfo.pointerId) {
        return;
      }
      canvasWrapper.releasePointerCapture(event.pointerId);
      panInfo = null;
    };

    const handleWheel = (event) => {
      if (!event.ctrlKey) {
        event.preventDefault();
      }
      event.preventDefault();
      closeContextMenu();
      const { clientX, clientY } = event;
      const focusWorld = screenToWorld(clientX, clientY);
      const scaleFactor = event.deltaY < 0 ? 1.1 : 0.9;
      const nextScale = clamp(view.scale * scaleFactor, MIN_SCALE, MAX_SCALE);
      if (nextScale === view.scale) {
        return;
      }
      view.scale = nextScale;
      const rect = canvasWrapper.getBoundingClientRect();
      const focusCanvas = worldPointToCanvas(focusWorld);
      view.offsetX = clientX - rect.left - focusCanvas.x * view.scale;
      view.offsetY = clientY - rect.top - focusCanvas.y * view.scale;
      applyViewTransform();
      updateGhostWireFromPoint(clientX, clientY);
    };

    await loadGateConfig();
    await loadFilesystemCustomGates();
    buildPalette();
    updateWrapperSize();

    canvasEl.addEventListener('dragover', (event) => event.preventDefault());
    canvasEl.addEventListener('drop', handleCanvasDrop);
    canvasEl.addEventListener('click', handleCanvasClick);
    document.addEventListener('keydown', handleKeyDown);

    canvasWrapper.addEventListener('pointerdown', handlePanPointerDown);
    canvasWrapper.addEventListener('pointermove', handlePanPointerMove);
    canvasWrapper.addEventListener('pointerup', handlePanPointerUp);
    canvasWrapper.addEventListener('pointercancel', handlePanPointerUp);
    canvasWrapper.addEventListener('wheel', handleWheel, { passive: false });

    window.addEventListener('resize', () => {
      closeContextMenu();
      updateWrapperSize();
    });
    document.addEventListener('pointerdown', handleGlobalPointerDown, true);

    if (clearButton) {
      clearButton.addEventListener('click', () => {
        resetToStarter();
      });
    }

    await loadState();
    if (!hasLoadedState) {
      hasLoadedState = true;
    }
    scheduleRender();

    window.logicSim = {
      exportToVhdl: (options) => exportCircuitToVhdl(options),
      snapshot: () => getCircuitSnapshot(),
      resetToStarter: () => resetToStarter()
    };

    window.addEventListener('message', (event) => {
      if (event?.data?.type === 'logic-sim:export-vhdl') {
        exportCircuitToVhdl();
      }
    });

    window.addEventListener('logic-sim:export-vhdl', () => {
      exportCircuitToVhdl();
    });
  });
})();
