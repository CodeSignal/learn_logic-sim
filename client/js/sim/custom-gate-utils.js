export const slugifyGateName = (value = '', fallback = 'custom-gate') => {
  const cleaned = value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
};

export const deriveAbbreviation = (label = '') => {
  const cleaned = (label || '').trim();
  if (!cleaned) {
    return 'CG';
  }
  const letters = cleaned
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
  return letters || cleaned.slice(0, 3).toUpperCase();
};

export const cloneGateTemplate = (template) => ({
  id: template.id,
  type: template.type,
  label: template.label,
  state: template.state,
  inputs: template.inputs,
  outputs: template.outputs,
  outputValues: new Array(template.outputs).fill(0),
  inputCache: new Array(template.inputs).fill(0)
});

export const buildConnectionLookupMap = (connections = []) => {
  const lookup = new Map();
  connections.forEach((connection) => {
    if (!connection?.to?.gateId) {
      return;
    }
    const key = `${connection.to.gateId}:${Number(connection.to.portIndex) || 0}`;
    lookup.set(key, {
      gateId: connection.from?.gateId,
      portIndex: Number(connection.from?.portIndex) || 0
    });
  });
  return lookup;
};

export const prepareCustomGateInterface = (snapshot = {}) => {
  const gates = Array.isArray(snapshot.gates) ? snapshot.gates : [];
  const inputs = gates.filter((gate) => gate.type === 'input');
  const outputs = gates.filter((gate) => gate.type === 'output');
  if (!inputs.length || !outputs.length) {
    throw new Error('Custom gate snapshots must include at least one input and one output gate.');
  }
  const normalizeName = (label, index, fallbackPrefix) => (label && label.trim())
    ? label.trim()
    : `${fallbackPrefix} ${index + 1}`;
  return {
    inputGateIds: inputs.map((gate) => gate.id),
    outputGateIds: outputs.map((gate) => gate.id),
    inputNames: inputs.map((gate, index) => normalizeName(gate.label || '', index, 'In')),
    outputNames: outputs.map((gate, index) => normalizeName(gate.label || '', index, 'Out'))
  };
};

export const compileCustomGateSnapshot = (snapshot = {}, gateDefinitions = {}) => {
  const interfaceInfo = prepareCustomGateInterface(snapshot);
  const gates = new Map();
  (snapshot.gates || []).forEach((gate) => {
    const definition = gateDefinitions[gate.type];
    if (!definition) {
      throw new Error(`Gate type "${gate.type}" is not registered.`);
    }
    gates.set(gate.id, {
      id: gate.id,
      type: gate.type,
      label: typeof gate.label === 'string' ? gate.label : '',
      state: Number(gate.state) === 1 ? 1 : 0,
      inputs: definition.inputs,
      outputs: definition.outputs
    });
  });
  const connections = (snapshot.connections || [])
    .map((connection) => ({
      id: connection.id,
      from: {
        gateId: connection.from?.gateId,
        portIndex: Number(connection.from?.portIndex) || 0
      },
      to: {
        gateId: connection.to?.gateId,
        portIndex: Number(connection.to?.portIndex) || 0
      }
    }))
    .filter((connection) =>
      gates.has(connection.from.gateId) &&
      gates.has(connection.to.gateId)
    );
  return {
    templateGates: gates,
    connections,
    interface: interfaceInfo,
    connectionLookup: buildConnectionLookupMap(connections)
  };
};
