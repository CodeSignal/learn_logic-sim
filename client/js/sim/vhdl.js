export const serializeSnapshotToVhdl = (snapshot = { gates: [], connections: [] }, gateDefinitions = {}) => {
  const gateMap = new Map((snapshot.gates || []).map((gate) => [gate.id, gate]));
  const connectionLookup = new Map();
  (snapshot.connections || []).forEach((connection) => {
    if (!connection?.to?.gateId) {
      return;
    }
    const key = `${connection.to.gateId}:${Number(connection.to?.portIndex) || 0}`;
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

  const getSignalName = (gate, index) => {
    const key = `${gate.id}:${index}`;
    if (signalNameMap.has(key)) {
      return signalNameMap.get(key);
    }
    const base = sanitizeIdentifier(`${gate.type}_${gate.id}_${index}`, `sig_${signalNameMap.size}`);
    const unique = ensureUnique(base);
    signalNameMap.set(key, unique);
    return unique;
  };

  const getPortName = (gate) => {
    const base = sanitizeIdentifier(gate.label || gate.type || 'output', `out_${portNameMap.size}`);
    const unique = ensureUnique(base);
    portNameMap.set(gate.id, unique);
    return unique;
  };

  const resolveInputSignal = (gateId, portIndex) => {
    const key = `${gateId}:${portIndex}`;
    const from = connectionLookup.get(key);
    if (!from) {
      return null;
    }
    const gate = gateMap.get(from.gateId);
    if (!gate) {
      return null;
    }
    const definition = gateDefinitions[gate.type];
    if (!definition) {
      return null;
    }
    if (definition.outputs === 0 && gate.type !== 'input') {
      return resolveInputSignal(gate.id, 0);
    }
    return getSignalName(gate, from.portIndex);
  };

  const applyCustomVhdlTemplate = (template, context) => {
    if (!template || !template.trim()) {
      return '';
    }
    const safeInputs = Array.isArray(context.inputs) && context.inputs.length
      ? context.inputs
      : [`'0'`];
    const safeOutputs = Array.isArray(context.outputs) ? context.outputs : [];
    const resolveIndexed = (collection, index, fallback = `'0'`) => {
      const numeric = Number(index);
      if (!Number.isFinite(numeric) || numeric < 0) {
        return fallback;
      }
      return collection[numeric] ?? (collection.length ? collection[0] : fallback);
    };
    return template
      .replace(/\{\{\s*input:(\d+)\s*\}\}/gi, (_, index) => resolveIndexed(safeInputs, index, `'0'`))
      .replace(/\{\{\s*output:(\d+)\s*\}\}/gi, (_, index) => resolveIndexed(safeOutputs, index, safeOutputs[0] || `'0'`))
      .replace(/\{\{\s*gateId\s*\}\}/gi, context.gate?.id || '')
      .replace(/\{\{\s*label\s*\}\}/gi, (context.gate?.label || '').trim())
      .replace(/\{\{\s*type\s*\}\}/gi, (context.definition?.label || '').trim());
  };

  const signalDeclarations = new Set();
  const assignmentLines = [];
  const outputAssignments = [];
  const outputPorts = [];

  (snapshot.gates || []).forEach((gate) => {
    const definition = gateDefinitions[gate.type];
    if (!definition) {
      return;
    }

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

    const definitionInputs = definition.inputs || 0;
    const inputSignals = [];
    for (let i = 0; i < definitionInputs; i += 1) {
      inputSignals.push(resolveInputSignal(gate.id, i));
    }
    const normalizedInputs = inputSignals.length ? inputSignals : [`'0'`];
    const totalOutputs = definition.outputs || 0;
    const targetSignals = [];
    for (let i = 0; i < totalOutputs; i += 1) {
      targetSignals.push(getSignalName(gate, i));
    }

    if (definition.renderMode === 'custom-square') {
      if (definition.customVhdl) {
        const snippet = applyCustomVhdlTemplate(definition.customVhdl, {
          inputs: normalizedInputs,
          outputs: targetSignals,
          gate,
          definition
        });
        snippet
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.trim().length)
          .forEach((line) => assignmentLines.push(line));
        return;
      }
      throw new Error(`Custom gate "${definition.label}" cannot be exported to VHDL. Please expand the circuit before exporting.`);
    }

    const targetSignal = targetSignals[0] || getSignalName(gate, 0);

    const binaryExpression = (operator) => normalizedInputs.reduce((acc, curr) => (
      acc ? `${acc} ${operator} ${curr}` : curr
    ), '');

    let expression;
    switch (gate.type) {
      case 'buffer':
        expression = normalizedInputs[0] || `'0'`;
        break;
      case 'not':
        expression = `not ${normalizedInputs[0] || "'0'"}`;
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
};
