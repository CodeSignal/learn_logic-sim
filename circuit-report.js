const { definitions: gateDefinitions } = require('./client/gate-registry');

const DEFAULT_REPORT_OPTIONS = {
  enabled: true,
  sections: {
    summary: true,
    gateCounts: true,
    gatePositions: true,
    spatialMetrics: true,
    connectionSummary: true,
    floatingPins: true,
    truthTable: true
  },
  truthTable: {
    maxInputs: 6,
    maxRows: 64
  }
};

const POSITION_LOG_LIMIT = 40;
const FLOATING_PIN_LOG_LIMIT = 20;
const FAN_LIST_LIMIT = 5;

function mergeBoolean(value, fallback = true) {
  return typeof value === 'boolean' ? value : fallback;
}

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  return fallback;
}

function normalizeBit(value) {
  if (value === 1 || value === '1') {
    return 1;
  }
  if (value === 0 || value === '0') {
    return 0;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 0 ? 1 : 0;
  }
  return value ? 1 : 0;
}

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function sortGates(a, b) {
  const labelA = (a.label || '').toLowerCase();
  const labelB = (b.label || '').toLowerCase();
  if (labelA === labelB) {
    return a.id.localeCompare(b.id, undefined, { sensitivity: 'base' });
  }
  return labelA.localeCompare(labelB);
}

function formatGateName(gate) {
  if (!gate) {
    return '[unknown]';
  }
  const parts = [`[${gate.type || 'unknown'}]`];
  if (gate.label && gate.label.trim()) {
    parts.push(`"${gate.label.trim()}"`);
  }
  parts.push(`(${gate.id})`);
  return parts.join(' ');
}

function buildCircuitModel(snapshot = {}) {
  const gates = Array.isArray(snapshot.gates) ? snapshot.gates : [];
  const sanitizedGates = gates
    .filter((gate) => gate && gate.id)
    .map((gate) => ({
      id: String(gate.id),
      type: typeof gate.type === 'string' ? gate.type : 'unknown',
      x: Number.isFinite(Number(gate.x)) ? Number(gate.x) : 0,
      y: Number.isFinite(Number(gate.y)) ? Number(gate.y) : 0,
      state: normalizeBit(gate.state),
      label: typeof gate.label === 'string' ? gate.label : ''
    }));

  const gateMap = new Map(sanitizedGates.map((gate) => [gate.id, gate]));

  const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];
  const sanitizedConnections = connections
    .map((connection) => ({
      id: connection?.id ? String(connection.id) : undefined,
      from: {
        gateId: connection?.from?.gateId ? String(connection.from.gateId) : undefined,
        portIndex: Number.isFinite(Number(connection?.from?.portIndex)) ? Number(connection.from.portIndex) : 0
      },
      to: {
        gateId: connection?.to?.gateId ? String(connection.to.gateId) : undefined,
        portIndex: Number.isFinite(Number(connection?.to?.portIndex)) ? Number(connection.to.portIndex) : 0
      }
    }))
    .filter((connection) => Boolean(connection.from.gateId) && Boolean(connection.to.gateId));

  const inputLookup = new Map();
  sanitizedConnections.forEach((connection) => {
    const key = `${connection.to.gateId}:${connection.to.portIndex}`;
    inputLookup.set(key, {
      gateId: connection.from.gateId,
      portIndex: connection.from.portIndex
    });
  });

  const outputLookup = new Map();
  sanitizedConnections.forEach((connection) => {
    const { gateId } = connection.from;
    if (!gateId) {
      return;
    }
    if (!outputLookup.has(gateId)) {
      outputLookup.set(gateId, []);
    }
    outputLookup.get(gateId).push({
      gateId: connection.to.gateId,
      portIndex: connection.to.portIndex
    });
  });

  return {
    gates: sanitizedGates,
    connections: sanitizedConnections,
    gateMap,
    inputLookup,
    outputLookup,
    inputs: sanitizedGates.filter((gate) => gate.type === 'input'),
    outputs: sanitizedGates.filter((gate) => gate.type === 'output')
  };
}

function evaluateGateOutputs(runtimeGate, inputs) {
  const { definition } = runtimeGate;
  if (!definition) {
    return [];
  }
  if (definition.logic) {
    return definition.logic(inputs, runtimeGate) || [];
  }
  return [];
}

function normalizeOutputArray(values, expectedLength) {
  const normalized = [];
  for (let i = 0; i < expectedLength; i += 1) {
    normalized.push(normalizeBit(values?.[i] ?? 0));
  }
  return normalized;
}

function evaluateModel(model, overrides = {}) {
  const runtimeGates = new Map();
  model.gates.forEach((gate) => {
    const definition = gateDefinitions[gate.type];
    const runtimeGate = {
      id: gate.id,
      type: gate.type,
      label: gate.label,
      state: gate.type === 'input'
        ? normalizeBit(Object.prototype.hasOwnProperty.call(overrides, gate.id) ? overrides[gate.id] : gate.state)
        : normalizeBit(gate.state),
      definition,
      outputs: new Array(definition?.outputs || 0).fill(0),
      inputCache: new Array(definition?.inputs || 0).fill(0)
    };
    runtimeGates.set(gate.id, runtimeGate);
  });

  const inputValueCache = new Map();

  const getInputValue = (gateId, portIndex) => {
    const key = `${gateId}:${portIndex}`;
    if (inputValueCache.has(key)) {
      return inputValueCache.get(key);
    }
    const source = model.inputLookup.get(key);
    let value = 0;
    if (source) {
      const runtimeSource = runtimeGates.get(source.gateId);
      if (runtimeSource && runtimeSource.outputs.length > source.portIndex) {
        value = runtimeSource.outputs[source.portIndex] ?? 0;
      }
    }
    const normalized = normalizeBit(value);
    inputValueCache.set(key, normalized);
    return normalized;
  };

  const iterationLimit = 32;
  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    let changed = false;
    inputValueCache.clear();
    for (const runtimeGate of runtimeGates.values()) {
      const definition = runtimeGate.definition;
      if (!definition) {
        continue;
      }
      const inputs = definition.inputs
        ? Array.from({ length: definition.inputs }, (_, index) => getInputValue(runtimeGate.id, index))
        : [];
      runtimeGate.inputCache = inputs;
      const produced = evaluateGateOutputs(runtimeGate, inputs);
      if (definition.outputs > 0) {
        const normalizedOutputs = normalizeOutputArray(produced, definition.outputs);
        if (!arraysEqual(runtimeGate.outputs, normalizedOutputs)) {
          runtimeGate.outputs = normalizedOutputs;
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  const outputValues = new Map();
  model.outputs.forEach((gate) => {
    const runtimeGate = runtimeGates.get(gate.id);
    if (!runtimeGate) {
      outputValues.set(gate.id, 0);
      return;
    }
    if (runtimeGate.definition && runtimeGate.definition.inputs > 0) {
      outputValues.set(gate.id, normalizeBit(runtimeGate.inputCache?.[0] ?? 0));
    } else if (runtimeGate.outputs.length > 0) {
      outputValues.set(gate.id, normalizeBit(runtimeGate.outputs[0]));
    } else {
      outputValues.set(gate.id, normalizeBit(runtimeGate.state));
    }
  });

  return { runtimeGates, outputValues };
}

function computeGateCounts(model) {
  const counts = {};
  model.gates.forEach((gate) => {
    const key = gate.type || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => {
    if (b[1] === a[1]) {
      return a[0].localeCompare(b[0]);
    }
    return b[1] - a[1];
  });
}

function computeSpatialMetrics(model) {
  if (!model.gates.length) {
    return null;
  }
  const xs = model.gates.map((gate) => gate.x);
  const ys = model.gates.map((gate) => gate.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function computeConnectionSummary(model) {
  const fanIn = new Map();
  const fanOut = new Map();
  model.connections.forEach((connection) => {
    if (connection.from.gateId) {
      fanOut.set(connection.from.gateId, (fanOut.get(connection.from.gateId) || 0) + 1);
    }
    if (connection.to.gateId) {
      fanIn.set(connection.to.gateId, (fanIn.get(connection.to.gateId) || 0) + 1);
    }
  });

  const gatesWithInputs = model.gates.filter((gate) => (gateDefinitions[gate.type]?.inputs || 0) > 0);
  const gatesWithOutputs = model.gates.filter((gate) => (gateDefinitions[gate.type]?.outputs || 0) > 0);

  const averageFanIn = gatesWithInputs.length
    ? model.connections.length / gatesWithInputs.length
    : 0;
  const averageFanOut = gatesWithOutputs.length
    ? model.connections.length / gatesWithOutputs.length
    : 0;

  const topFanIn = Array.from(fanIn.entries())
    .map(([gateId, total]) => ({ gate: model.gateMap.get(gateId), total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, FAN_LIST_LIMIT);

  const topFanOut = Array.from(fanOut.entries())
    .map(([gateId, total]) => ({ gate: model.gateMap.get(gateId), total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, FAN_LIST_LIMIT);

  return {
    totalConnections: model.connections.length,
    averageFanIn,
    averageFanOut,
    topFanIn,
    topFanOut
  };
}

function detectFloatingPins(model) {
  const openInputs = [];
  const floatingOutputs = [];

  model.gates.forEach((gate) => {
    const definition = gateDefinitions[gate.type];
    if (!definition) {
      return;
    }
    if (definition.inputs > 0 && gate.type !== 'input') {
      for (let i = 0; i < definition.inputs; i += 1) {
        const key = `${gate.id}:${i}`;
        if (!model.inputLookup.has(key)) {
          openInputs.push({ gate, portIndex: i });
        }
      }
    }
    if (definition.outputs > 0 && gate.type !== 'output') {
      const fanout = model.outputLookup.get(gate.id)?.length || 0;
      if (fanout === 0) {
        floatingOutputs.push(gate);
      }
    }
  });

  return { openInputs, floatingOutputs };
}

function generateTruthTable(model, options) {
  const orderedInputs = [...model.inputs].sort(sortGates);
  const orderedOutputs = [...model.outputs].sort(sortGates);

  if (!orderedOutputs.length) {
    return { skipped: true, reason: 'No output gates defined' };
  }

  const maxInputs = toPositiveInteger(options?.maxInputs, DEFAULT_REPORT_OPTIONS.truthTable.maxInputs);
  const inputCount = orderedInputs.length;
  if (inputCount > maxInputs) {
    return {
      skipped: true,
      reason: `Input count (${inputCount}) exceeds configured limit (${maxInputs})`
    };
  }

  const maxRows = toPositiveInteger(options?.maxRows, DEFAULT_REPORT_OPTIONS.truthTable.maxRows);
  const totalRows = Math.max(1, 2 ** inputCount);
  const rowsToRender = Math.min(totalRows, maxRows);
  const rows = [];

  for (let rowIndex = 0; rowIndex < rowsToRender; rowIndex += 1) {
    const assignment = {};
    const inputBits = [];
    for (let bitIndex = 0; bitIndex < inputCount; bitIndex += 1) {
      const gate = orderedInputs[bitIndex];
      const shift = inputCount - bitIndex - 1;
      const bit = ((rowIndex >> shift) & 1) || 0;
      assignment[gate.id] = bit;
      inputBits.push(bit);
    }
    const evaluation = evaluateModel(model, assignment);
    const outputBits = orderedOutputs.map((gate) => evaluation.outputValues.get(gate.id) || 0);
    rows.push({ index: rowIndex, inputs: inputBits, outputs: outputBits });
  }

  return {
    skipped: false,
    header: {
      inputs: orderedInputs,
      outputs: orderedOutputs
    },
    rows,
    totalRows,
    truncated: rowsToRender < totalRows
  };
}

function buildReportOptions(gateConfig = {}) {
  const reportConfig = gateConfig?.exportReport || {};
  const sectionOverrides = reportConfig.sections || {};
  const truthTableOverrides = reportConfig.truthTable || {};

  const sections = {
    summary: mergeBoolean(sectionOverrides.summary, DEFAULT_REPORT_OPTIONS.sections.summary),
    gateCounts: mergeBoolean(sectionOverrides.gateCounts, DEFAULT_REPORT_OPTIONS.sections.gateCounts),
    gatePositions: mergeBoolean(sectionOverrides.gatePositions, DEFAULT_REPORT_OPTIONS.sections.gatePositions),
    spatialMetrics: mergeBoolean(sectionOverrides.spatialMetrics, DEFAULT_REPORT_OPTIONS.sections.spatialMetrics),
    connectionSummary: mergeBoolean(sectionOverrides.connectionSummary, DEFAULT_REPORT_OPTIONS.sections.connectionSummary),
    floatingPins: mergeBoolean(sectionOverrides.floatingPins, DEFAULT_REPORT_OPTIONS.sections.floatingPins),
    truthTable: mergeBoolean(sectionOverrides.truthTable, DEFAULT_REPORT_OPTIONS.sections.truthTable)
  };

  const truthTable = {
    enabled: sections.truthTable && mergeBoolean(truthTableOverrides.enabled, true),
    maxInputs: toPositiveInteger(truthTableOverrides.maxInputs, DEFAULT_REPORT_OPTIONS.truthTable.maxInputs),
    maxRows: toPositiveInteger(truthTableOverrides.maxRows, DEFAULT_REPORT_OPTIONS.truthTable.maxRows)
  };

  return {
    enabled: mergeBoolean(reportConfig.enabled, DEFAULT_REPORT_OPTIONS.enabled),
    sections: {
      ...sections,
      truthTable: truthTable.enabled
    },
    truthTable
  };
}

function printCircuitReport(snapshot, gateConfig = {}) {
  const options = buildReportOptions(gateConfig);
  if (!options.enabled) {
    return;
  }

  const model = buildCircuitModel(snapshot || {});
  console.log('\n=== Circuit Export Report ===');

  if (options.sections.summary) {
    console.log(`Total gates: ${model.gates.length}`);
    console.log(`Total connections: ${model.connections.length}`);
    console.log(`Inputs: ${model.inputs.length} | Outputs: ${model.outputs.length}`);
  }

  if (options.sections.gateCounts) {
    const counts = computeGateCounts(model);
    if (!counts.length) {
      console.log('Gate counts: n/a (no gates present)');
    } else {
      console.log('Gate counts:');
      counts.forEach(([type, count]) => {
        console.log(`  - ${type}: ${count}`);
      });
    }
  }

  if (options.sections.gatePositions) {
    if (!model.gates.length) {
      console.log('Gate positions: n/a (no gates present)');
    } else {
      console.log('Gate positions:');
      model.gates.slice(0, POSITION_LOG_LIMIT).forEach((gate) => {
        console.log(`  - ${formatGateName(gate)} @ (${gate.x}, ${gate.y})`);
      });
      if (model.gates.length > POSITION_LOG_LIMIT) {
        console.log(`  ... ${model.gates.length - POSITION_LOG_LIMIT} additional gates not shown`);
      }
    }
  }

  if (options.sections.spatialMetrics) {
    const metrics = computeSpatialMetrics(model);
    if (!metrics) {
      console.log('Spatial metrics: n/a (no gates present)');
    } else {
      console.log('Spatial metrics:');
      console.log(`  - Bounds X: ${metrics.minX} → ${metrics.maxX} (width ${metrics.width})`);
      console.log(`  - Bounds Y: ${metrics.minY} → ${metrics.maxY} (height ${metrics.height})`);
    }
  }

  if (options.sections.connectionSummary) {
    const summary = computeConnectionSummary(model);
    console.log('Connection summary:');
    console.log(`  - Total: ${summary.totalConnections}`);
    console.log(`  - Avg fan-in: ${summary.averageFanIn.toFixed(2)}`);
    console.log(`  - Avg fan-out: ${summary.averageFanOut.toFixed(2)}`);
    if (summary.topFanIn.length) {
      console.log('  - Highest fan-in:');
      summary.topFanIn.forEach((entry) => {
        console.log(`      • ${formatGateName(entry.gate)} → ${entry.total} inputs`);
      });
    }
    if (summary.topFanOut.length) {
      console.log('  - Highest fan-out:');
      summary.topFanOut.forEach((entry) => {
        console.log(`      • ${formatGateName(entry.gate)} → ${entry.total} outputs`);
      });
    }
  }

  if (options.sections.floatingPins) {
    const floating = detectFloatingPins(model);
    if (!floating.openInputs.length && !floating.floatingOutputs.length) {
      console.log('Connectivity check: all gate inputs and outputs are connected.');
    } else {
      console.log('Connectivity diagnostics:');
      if (floating.openInputs.length) {
        console.log('  Unconnected gate inputs:');
        floating.openInputs.slice(0, FLOATING_PIN_LOG_LIMIT).forEach((entry) => {
          console.log(`      • ${formatGateName(entry.gate)} input ${entry.portIndex}`);
        });
        if (floating.openInputs.length > FLOATING_PIN_LOG_LIMIT) {
          console.log(`      ... ${floating.openInputs.length - FLOATING_PIN_LOG_LIMIT} additional open inputs`);
        }
      } else {
        console.log('  Unconnected gate inputs: none');
      }
      if (floating.floatingOutputs.length) {
        console.log('  Gate outputs with no destinations:');
        floating.floatingOutputs.slice(0, FLOATING_PIN_LOG_LIMIT).forEach((gate) => {
          console.log(`      • ${formatGateName(gate)}`);
        });
        if (floating.floatingOutputs.length > FLOATING_PIN_LOG_LIMIT) {
          console.log(`      ... ${floating.floatingOutputs.length - FLOATING_PIN_LOG_LIMIT} additional floating outputs`);
        }
      } else {
        console.log('  Gate outputs with no destinations: none');
      }
    }
  }

  if (options.truthTable.enabled) {
    const table = generateTruthTable(model, options.truthTable);
    if (table.skipped) {
      console.log(`Truth table: skipped (${table.reason})`);
    } else if (!table.rows.length) {
      console.log('Truth table: no rows to display');
    } else {
      const inputLabels = table.header.inputs.map((gate) => gate.label || gate.id);
      const outputLabels = table.header.outputs.map((gate) => gate.label || gate.id);
      console.log(`Truth table (${table.rows.length}/${table.totalRows} rows${table.truncated ? ', truncated' : ''}):`);
      const leftHeader = inputLabels.length ? inputLabels.join(' ') : '(no inputs)';
      const rightHeader = outputLabels.length ? outputLabels.join(' ') : '(no outputs)';
      console.log(`  ${leftHeader} || ${rightHeader}`);
      table.rows.forEach((row) => {
        const left = row.inputs.length ? row.inputs.map((value) => (value ? 1 : 0)).join('   ') : '-';
        const right = row.outputs.length ? row.outputs.map((value) => (value ? 1 : 0)).join('   ') : '-';
        console.log(`  ${left} || ${right}`);
      });
      if (table.truncated) {
        console.log(`  ... ${table.totalRows - table.rows.length} additional rows not shown`);
      }
    }
  }

  console.log('=== End of Circuit Report ===\n');
}

module.exports = {
  buildReportOptions,
  printCircuitReport
};
