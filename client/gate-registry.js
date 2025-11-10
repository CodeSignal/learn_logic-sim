(function (root, factory) {
  const registry = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = registry;
  } else {
    root.gateRegistry = registry;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const definitions = Object.create(null);
  const paletteOrder = [];

  const defaultPortLayout = () => ({
    inputs: [],
    outputs: []
  });

  const assignDefaults = (definition = {}) => {
    const normalized = { ...definition };
    normalized.inputs = Number.isInteger(definition.inputs) ? definition.inputs : 0;
    normalized.outputs = Number.isInteger(definition.outputs) ? definition.outputs : 0;
    normalized.portLayout = definition.portLayout ? definition.portLayout : defaultPortLayout();
    normalized.logic = typeof definition.logic === 'function' ? definition.logic : () => [];
    return normalized;
  };

  const insertIntoPalette = (type, position) => {
    const existingIndex = paletteOrder.indexOf(type);
    if (existingIndex >= 0) {
      paletteOrder.splice(existingIndex, 1);
    }
    if (typeof position === 'number' && position >= 0 && position <= paletteOrder.length) {
      paletteOrder.splice(position, 0, type);
    } else if (!paletteOrder.includes(type)) {
      paletteOrder.push(type);
    }
  };

  const registerGate = (type, definition, options = {}) => {
    if (!type || typeof type !== 'string') {
      throw new Error('Gate type must be a non-empty string');
    }
    const normalized = assignDefaults(definition);
    definitions[type] = normalized;
    const { addToPalette = true, paletteIndex } = options;
    if (addToPalette) {
      insertIntoPalette(type, paletteIndex);
    }
    return normalized;
  };

  registerGate(
    'input',
    {
      label: 'Input',
      description: 'Manual toggle that emits a high (1) or low (0) signal.',
      icon: './gates/input.svg',
      inputs: 0,
      outputs: 1,
      allowToggle: true,
      supportsLabel: true,
      primaryAction: 'toggle-state',
      actions: [
        {
          id: 'toggle-state',
          label: 'Toggle value',
          perform: ({ gate, evaluateCircuit, scheduleRender, markDirty, refreshSelection }) => {
            gate.state = gate.state ? 0 : 1;
            evaluateCircuit(true);
            scheduleRender();
            markDirty();
            refreshSelection();
          }
        }
      ],
      portLayout: {
        inputs: [],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (_, gate) => [gate.state ? 1 : 0]
    },
    { paletteIndex: 0 }
  );

  registerGate(
    'output',
    {
      label: 'Output',
      description: 'Shows the value from a single input line.',
      icon: './gates/output.svg',
      inputs: 1,
      outputs: 0,
      supportsLabel: true,
      portLayout: {
        inputs: [{ x: 0, y: 32 }],
        outputs: []
      },
      logic: (inputs, gate) => {
        gate.state = inputs[0] ?? 0;
        return [];
      }
    },
    { paletteIndex: 1 }
  );

  registerGate(
    'buffer',
    {
      label: 'Buffer',
      description: 'Passes the input signal through unchanged.',
      icon: './gates/buffer.svg',
      inputs: 1,
      outputs: 1,
      portLayout: {
        inputs: [{ x: 0, y: 32 }],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (inputs) => [inputs[0] ?? 0]
    },
    { paletteIndex: 2 }
  );

  registerGate(
    'not',
    {
      label: 'NOT',
      description: 'Inverts the incoming signal.',
      icon: './gates/not.svg',
      inputs: 1,
      outputs: 1,
      portLayout: {
        inputs: [{ x: 0, y: 32 }],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (inputs) => [inputs[0] ? 0 : 1]
    },
    { paletteIndex: 3 }
  );

  registerGate(
    'and',
    {
      label: 'AND',
      description: 'Outputs 1 when all inputs are high.',
      icon: './gates/and.svg',
      inputs: 2,
      outputs: 1,
      portLayout: {
        inputs: [
          { x: 0, y: 24 },
          { x: 0, y: 40 }
        ],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (inputs) => [inputs.every(Boolean) ? 1 : 0]
    },
    { paletteIndex: 4 }
  );

  registerGate(
    'nand',
    {
      label: 'NAND',
      description: 'Outputs 0 only when all inputs are high.',
      icon: './gates/nand.svg',
      inputs: 2,
      outputs: 1,
      portLayout: {
        inputs: [
          { x: 0, y: 24 },
          { x: 0, y: 40 }
        ],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (inputs) => [inputs.every(Boolean) ? 0 : 1]
    },
    { paletteIndex: 5 }
  );

  registerGate(
    'or',
    {
      label: 'OR',
      description: 'Outputs 1 when any input is high.',
      icon: './gates/or.svg',
      inputs: 2,
      outputs: 1,
      portLayout: {
        inputs: [
          { x: 0, y: 24 },
          { x: 0, y: 40 }
        ],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (inputs) => [inputs.some(Boolean) ? 1 : 0]
    },
    { paletteIndex: 6 }
  );

  registerGate(
    'nor',
    {
      label: 'NOR',
      description: 'Outputs 1 only when all inputs are low.',
      icon: './gates/nor.svg',
      inputs: 2,
      outputs: 1,
      portLayout: {
        inputs: [
          { x: 0, y: 24 },
          { x: 0, y: 40 }
        ],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (inputs) => [inputs.some(Boolean) ? 0 : 1]
    },
    { paletteIndex: 7 }
  );

  registerGate(
    'xor',
    {
      label: 'XOR',
      description: 'Outputs 1 when an odd number of inputs are high.',
      icon: './gates/xor.svg',
      inputs: 2,
      outputs: 1,
      portLayout: {
        inputs: [
          { x: 0, y: 24 },
          { x: 0, y: 40 }
        ],
        outputs: [{ x: 64, y: 32 }]
      },
      logic: (inputs) => [inputs.filter(Boolean).length % 2 ? 1 : 0]
    },
    { paletteIndex: 8 }
  );

  return {
    definitions,
    paletteOrder,
    registerGate
  };
});
