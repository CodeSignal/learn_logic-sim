import { COORDINATE_VERSION, HALF_WORKSPACE } from './constants.js';
import { normalizeRotation } from './geometry.js';
import { prepareCustomGateInterface } from './custom-gate-utils.js';

export const normalizeSnapshot = (input = {}) => {
  const payload = input && typeof input === 'object'
    ? (typeof input.snapshot === 'object' ? input.snapshot : input)
    : {};

  const declaredOrigin = typeof payload.origin === 'string' ? payload.origin.toLowerCase() : null;
  const version = Number(payload.version) || 1;
  const originMode = declaredOrigin === 'center'
    ? 'center'
    : (declaredOrigin === 'top-left' ? 'top-left' : (version >= COORDINATE_VERSION ? 'center' : 'top-left'));

  const convertCoordinate = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return originMode === 'center' ? numeric : numeric - HALF_WORKSPACE;
  };

  const gatesSource = Array.isArray(payload.gates)
    ? payload.gates
    : (Array.isArray(payload.positions) ? payload.positions : []);

  const gates = gatesSource.map((entry) => ({
    id: entry.id,
    type: entry.type,
    x: convertCoordinate(entry.x),
    y: convertCoordinate(entry.y),
    label: typeof entry.label === 'string' ? entry.label : '',
    state: Number(entry.state) === 1 ? 1 : 0,
    rotation: normalizeRotation(entry.rotation)
  }));

  const normalizePortIndex = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };

  const connections = Array.isArray(payload.connections)
    ? payload.connections.map((connection) => ({
        id: connection.id ?? Math.random().toString(36).slice(2, 15),
        from: {
          gateId: connection.from?.gateId,
          portIndex: normalizePortIndex(connection.from?.portIndex)
        },
        to: {
          gateId: connection.to?.gateId,
          portIndex: normalizePortIndex(connection.to?.portIndex)
        }
      }))
    : [];

  const customGates = Array.isArray(payload.customGates)
    ? payload.customGates
        .map((entry) => {
          if (!entry || typeof entry.type !== 'string') {
            return null;
          }
          return {
            type: entry.type,
            label: typeof entry.label === 'string' ? entry.label : entry.type,
            fileName: typeof entry.fileName === 'string' ? entry.fileName : '',
            inputNames: Array.isArray(entry.inputNames)
              ? entry.inputNames.filter((name) => typeof name === 'string')
              : [],
            outputNames: Array.isArray(entry.outputNames)
              ? entry.outputNames.filter((name) => typeof name === 'string')
              : [],
            abbreviation: typeof entry.abbreviation === 'string' ? entry.abbreviation : undefined,
            customVhdl: typeof entry.customVhdl === 'string' && entry.customVhdl.trim()
              ? entry.customVhdl.trim()
              : '',
            source: entry.source === 'embedded' ? 'embedded' : (entry.source === 'filesystem' ? 'filesystem' : 'library'),
            snapshot: typeof entry.snapshot === 'object' ? entry.snapshot : null
          };
        })
        .filter(Boolean)
    : [];

  const nextId = Number(payload.nextId);

  return {
    version,
    origin: 'center',
    nextId: Number.isFinite(nextId) && nextId > 0 ? nextId : undefined,
    gates,
    connections,
    customGates
  };
};

export const flattenSnapshotForExport = (snapshot = {}, gateDefinitions = {}) => {
  const originalGates = Array.isArray(snapshot.gates) ? snapshot.gates : [];
  const originalConnections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
  const usedIds = new Set(originalGates.map((gate) => String(gate.id)));
  const mapOriginalId = new Map();
  const flattenedGates = [];
  const flattenedConnections = [];
  const expansions = new Map();
  let connectionCounter = 0;

  const generateGateId = () => {
    let candidate;
    do {
      candidate = `cxg${connectionCounter++}`;
    } while (usedIds.has(candidate));
    usedIds.add(candidate);
    return candidate;
  };

  const generateConnectionId = (preferred) => {
    if (preferred && !usedIds.has(preferred)) {
      usedIds.add(preferred);
      return preferred;
    }
    let candidate;
    do {
      candidate = `cxc${connectionCounter++}`;
    } while (usedIds.has(candidate));
    usedIds.add(candidate);
    return candidate;
  };

  const addConnection = (from, to, originalId) => {
    if (!from?.gateId || !to?.gateId) {
      return;
    }
    flattenedConnections.push({
      id: generateConnectionId(originalId),
      from: { gateId: from.gateId, portIndex: Number(from.portIndex) || 0 },
      to: { gateId: to.gateId, portIndex: Number(to.portIndex) || 0 }
    });
  };

  originalGates.forEach((gate) => {
    const definition = gateDefinitions[gate.type];
    if (!definition) {
      return;
    }
    if (definition.renderMode !== 'custom-square' || !definition.customSnapshot) {
      mapOriginalId.set(gate.id, gate.id);
      flattenedGates.push({ ...gate });
      return;
    }

    const snapshotClone = normalizeSnapshot(definition.customSnapshot);
    const interfaceInfo = prepareCustomGateInterface(snapshotClone);
    const placeholderInputIndex = new Map();
    interfaceInfo.inputGateIds.forEach((id, index) => placeholderInputIndex.set(id, index));
    const placeholderOutputIndex = new Map();
    interfaceInfo.outputGateIds.forEach((id, index) => placeholderOutputIndex.set(id, index));

    const internalGateIdMap = new Map();

    snapshotClone.gates.forEach((child) => {
      if (placeholderInputIndex.has(child.id) || placeholderOutputIndex.has(child.id)) {
        return;
      }
      const childDefinition = gateDefinitions[child.type];
      if (!childDefinition) {
        throw new Error(`Custom gate snapshot for "${definition.label}" references unknown gate "${child.type}".`);
      }
      if (childDefinition.renderMode === 'custom-square') {
        throw new Error(`Nested custom gates are not supported inside "${definition.label}".`);
      }
      const newId = generateGateId();
      internalGateIdMap.set(child.id, newId);
      flattenedGates.push({ ...child, id: newId });
    });

    const inputTargets = new Map();
    const outputSources = new Map();

    snapshotClone.connections.forEach((connection) => {
      const fromIndex = placeholderInputIndex.get(connection.from?.gateId);
      const toIndex = placeholderOutputIndex.get(connection.to?.gateId);
      if (fromIndex !== undefined) {
        const targetGateId = internalGateIdMap.get(connection.to?.gateId);
        if (targetGateId) {
          const current = inputTargets.get(fromIndex) || [];
          current.push({
            gateId: targetGateId,
            portIndex: Number(connection.to?.portIndex) || 0
          });
          inputTargets.set(fromIndex, current);
        }
        return;
      }
      if (toIndex !== undefined) {
        const sourceGateId = internalGateIdMap.get(connection.from?.gateId);
        if (sourceGateId) {
          const current = outputSources.get(toIndex) || [];
          current.push({
            gateId: sourceGateId,
            portIndex: Number(connection.from?.portIndex) || 0
          });
          outputSources.set(toIndex, current);
        }
        return;
      }

      const fromGateId = internalGateIdMap.get(connection.from?.gateId);
      const toGateId = internalGateIdMap.get(connection.to?.gateId);
      if (fromGateId && toGateId) {
        addConnection(
          { gateId: fromGateId, portIndex: Number(connection.from?.portIndex) || 0 },
          { gateId: toGateId, portIndex: Number(connection.to?.portIndex) || 0 },
          connection.id
        );
      }
    });

    mapOriginalId.set(gate.id, gate.id);
    expansions.set(gate.id, {
      interface: interfaceInfo,
      inputs: inputTargets,
      outputs: outputSources
    });
  });

  originalConnections.forEach((connection) => {
    const sourceExpansion = expansions.get(connection.from?.gateId);
    const targetExpansion = expansions.get(connection.to?.gateId);
    const sourceList = sourceExpansion
      ? sourceExpansion.outputs.get(Number(connection.from?.portIndex) || 0)
      : [{ gateId: mapOriginalId.get(connection.from?.gateId), portIndex: Number(connection.from?.portIndex) || 0 }];
    const targetList = targetExpansion
      ? targetExpansion.inputs.get(Number(connection.to?.portIndex) || 0)
      : [{ gateId: mapOriginalId.get(connection.to?.gateId), portIndex: Number(connection.to?.portIndex) || 0 }];

    sourceList.forEach((source) => {
      if (!source?.gateId) {
        return;
      }
      targetList.forEach((target) => {
        if (!target?.gateId) {
          return;
        }
        addConnection(source, target, connection.id);
      });
    });
  });

  const nextIdCandidate = flattenedGates.reduce((max, gate) => {
    const numeric = Number(String(gate.id).replace(/\D+/g, ''));
    if (Number.isFinite(numeric)) {
      return Math.max(max, numeric + 1);
    }
    return max;
  }, 1);

  return {
    version: snapshot.version || COORDINATE_VERSION,
    origin: snapshot.origin || 'center',
    nextId: Math.max(Number(snapshot.nextId) || 1, nextIdCandidate),
    gates: flattenedGates,
    connections: flattenedConnections
  };
};
