const gateRegistry = require('./client/gate-registry');

const gateDefinitions = gateRegistry?.definitions || {};

function serializeSnapshotToVhdl(snapshot = { gates: [], connections: [] }) {
  const gateMap = new Map((snapshot.gates || []).map((gate) => [gate.id, gate]));
  const connectionLookup = new Map();
  const customGateLookup = new Map();
  (snapshot.customGates || []).forEach((entry) => {
    if (entry?.type) {
      customGateLookup.set(entry.type, entry);
    }
  });
  (snapshot.connections || []).forEach((connection) => {
    if (!connection?.to?.gateId) {
      return;
    }
    const key = `${connection.to.gateId}:${Number(connection.to.portIndex) || 0}`;
    connectionLookup.set(key, {
      gateId: connection.from?.gateId,
      portIndex: Number(connection.from?.portIndex) || 0
    });
  });

  const usedNames = new Set();
  const signalNameMap = new Map();
  const portNameMap = new Map();

  const sanitizeIdentifier = (value, fallback) => {
    const cleaned = (value || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_');
    let candidate = cleaned.replace(/^[^a-z_]+/, '');
    if (!candidate) {
      candidate = fallback;
    }
    return candidate || fallback;
  };

  const ensureUnique = (base) => {
    let candidate = base;
    let counter = 1;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };

  const getSignalName = (gate, index = 0) => {
    const key = `${gate.id}:${index}`;
    if (signalNameMap.has(key)) {
      return signalNameMap.get(key);
    }
    const definition = gateDefinitions[gate.type] || customGateLookup.get(gate.type);
    const typeSlug = sanitizeIdentifier((definition?.label || gate.type), `node_${gate.id}`);
    const labelSlug = (gate.label || '').trim() ? sanitizeIdentifier(gate.label, `${typeSlug}_${gate.id}`) : '';
    const base = labelSlug || `${typeSlug}_${gate.id}_${index}`;
    const unique = ensureUnique(base || `node_${gate.id}_${index}`);
    signalNameMap.set(key, unique);
    return unique;
  };

  const getPortName = (gate) => {
    if (portNameMap.has(gate.id)) {
      return portNameMap.get(gate.id);
    }
    const definition = gateDefinitions[gate.type];
    const typeSlug = sanitizeIdentifier((definition?.label || gate.type), `out_${gate.id}`);
    const baseCandidate = (gate.label || '').trim() ? sanitizeIdentifier(gate.label, `${typeSlug}_${gate.id}`) : `${typeSlug}_${gate.id}`;
    const unique = ensureUnique(baseCandidate || `out_${gate.id}`);
    portNameMap.set(gate.id, unique);
    return unique;
  };

  const resolveInputSignal = (gateId, portIndex) => {
    const key = `${gateId}:${portIndex}`;
    const from = connectionLookup.get(key);
    if (!from) {
      return `'0'`;
    }
    const sourceGate = gateMap.get(from.gateId);
    if (!sourceGate) {
      return `'0'`;
    }
    return getSignalName(sourceGate, from.portIndex || 0);
  };

  const signalDeclarations = new Set();
  const assignmentLines = [];
  const outputAssignments = [];
  const outputPorts = [];

  (snapshot.gates || []).forEach((gate) => {
    const registryDefinition = gateDefinitions[gate.type];
    const customEntry = registryDefinition ? null : customGateLookup.get(gate.type);
    if (!registryDefinition && !customEntry) {
      return;
    }
    const definition = registryDefinition || {
      label: customEntry.label || gate.type,
      inputs: Array.isArray(customEntry.inputNames) ? customEntry.inputNames.length : 0,
      outputs: Array.isArray(customEntry.outputNames) ? customEntry.outputNames.length : 0
    };

    if (definition.outputs > 0 && gate.type !== 'output') {
      for (let i = 0; i < definition.outputs; i += 1) {
        const sig = getSignalName(gate, i);
        signalDeclarations.add(`signal ${sig} : STD_LOGIC;`);
      }
    }

    if (gate.type === 'input') {
      const sig = getSignalName(gate, 0);
      const comment = gate.label ? ` -- ${definition.label} ${gate.label}` : ` -- ${definition.label}`;
      assignmentLines.push(`${sig} <= '${gate.state ? '1' : '0'}';${comment}`);
      return;
    }

    if (gate.type === 'output') {
      const inputSignal = resolveInputSignal(gate.id, 0);
      const portName = getPortName(gate);
      outputPorts.push(`${portName} : out STD_LOGIC`);
      const comment = gate.label ? ` -- ${definition.label} ${gate.label}` : ` -- ${definition.label}`;
      outputAssignments.push(`${portName} <= ${inputSignal || "'0'"};${comment}`);
      return;
    }

    if (customEntry) {
      throw new Error(`Custom gate "${definition.label}" cannot be exported to VHDL. Please expand the circuit before exporting.`);
    }

    const normalizedInputs = [];
    for (let i = 0; i < definition.inputs; i += 1) {
      normalizedInputs.push(resolveInputSignal(gate.id, i));
    }

    const targetSignal = getSignalName(gate, 0);

    const binaryExpression = (operator) => {
      if (!normalizedInputs.length) {
        return null;
      }
      if (normalizedInputs.length === 1) {
        return normalizedInputs[0];
      }
      return normalizedInputs.map((input) => `(${input})`).join(` ${operator} `);
    };

    let expression = normalizedInputs[0] || `'0'`;
    switch (gate.type) {
      case 'buffer':
        expression = normalizedInputs[0] || `'0'`;
        break;
      case 'not':
        expression = normalizedInputs[0] ? `not (${normalizedInputs[0]})` : `'1'`;
        break;
      case 'and':
        expression = binaryExpression('and') || `'0'`;
        break;
      case 'nand':
        expression = `not (${binaryExpression('and') || "'0'"})`;
        break;
      case 'or':
        expression = binaryExpression('or') || `'0'`;
        break;
      case 'nor':
        expression = `not (${binaryExpression('or') || "'0'"})`;
        break;
      case 'xor':
        expression = binaryExpression('xor') || `'0'`;
        break;
      default:
        expression = normalizedInputs[0] || `'0'`;
    }

    const comment = gate.label ? ` -- ${definition.label} ${gate.label}` : ` -- ${definition.label}`;
    assignmentLines.push(`${targetSignal} <= ${expression};${comment}`);
  });

  const commentLines = [
    '-- Logic Circuit Lab export',
    ''
  ];

  const headerLines = [
    'library IEEE;',
    'use IEEE.STD_LOGIC_1164.ALL;',
    ''
  ];

  const entityLines = outputPorts.length
    ? [
        'entity logic_circuit_lab is',
        '  port (',
        `    ${outputPorts.join(',\n    ')}`,
        '  );',
        'end entity logic_circuit_lab;',
        ''
      ]
    : [
        'entity logic_circuit_lab is',
        'end entity logic_circuit_lab;',
        ''
      ];

  const architectureLines = [
    'architecture behavioral of logic_circuit_lab is',
    ...Array.from(signalDeclarations).map((line) => `  ${line}`),
    'begin',
    ...assignmentLines.map((line) => `  ${line}`),
    ...outputAssignments.map((line) => `  ${line}`),
    'end architecture behavioral;',
    ''
  ];

  return [
    ...commentLines,
    ...headerLines,
    ...entityLines,
    ...architectureLines
  ].join('\n');
}

module.exports = {
  serializeSnapshotToVhdl
};
