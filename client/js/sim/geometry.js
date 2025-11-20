import {
  ROTATION_STEP,
  DEFAULT_GATE_DIMENSIONS,
  GRID_SIZE,
  BASE_ICON_SIZE,
  CUSTOM_GATE_PORT_SPACING,
  HALF_WORKSPACE
} from './constants.js';

export const normalizeRotation = (value = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const steps = Math.round(numeric / ROTATION_STEP);
  const normalized = steps * ROTATION_STEP;
  return ((normalized % 360) + 360) % 360;
};

export const getGateRotation = (gate) => normalizeRotation(gate?.rotation || 0);

export const normalizeDimensions = (size = DEFAULT_GATE_DIMENSIONS) => {
  const width = Number(size?.width);
  const height = Number(size?.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : DEFAULT_GATE_DIMENSIONS.width,
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_GATE_DIMENSIONS.height
  };
};

export const rotatePoint = (point, rotation = 0, size = DEFAULT_GATE_DIMENSIONS) => {
  const { width, height } = normalizeDimensions(size);
  const fallback = point || { x: width / 2, y: height / 2 };
  const baseX = Number(fallback?.x);
  const baseY = Number(fallback?.y);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const x = Number.isFinite(baseX) ? baseX : halfWidth;
  const y = Number.isFinite(baseY) ? baseY : halfHeight;
  const offsetX = x - halfWidth;
  const offsetY = y - halfHeight;
  const quarterTurns = Math.round(normalizeRotation(rotation) / ROTATION_STEP) % 4;
  let rotatedX = offsetX;
  let rotatedY = offsetY;
  switch ((quarterTurns + 4) % 4) {
    case 1:
      rotatedX = -offsetY;
      rotatedY = offsetX;
      break;
    case 2:
      rotatedX = -offsetX;
      rotatedY = -offsetY;
      break;
    case 3:
      rotatedX = offsetY;
      rotatedY = -offsetX;
      break;
    default:
      break;
  }
  return {
    x: rotatedX + halfWidth,
    y: rotatedY + halfHeight
  };
};

export const alignSizeToGrid = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return GRID_SIZE;
  }
  return Math.ceil(numeric / GRID_SIZE) * GRID_SIZE;
};

export const computeCustomGateDimensions = (inputCount = 0, outputCount = 0) => {
  const maxPorts = Math.max(1, inputCount, outputCount);
  const rawHeight = (maxPorts + 1) * CUSTOM_GATE_PORT_SPACING;
  const height = Math.max(BASE_ICON_SIZE, alignSizeToGrid(rawHeight));
  return {
    width: BASE_ICON_SIZE,
    height
  };
};

export const distributePorts = (count, side, dimensions = DEFAULT_GATE_DIMENSIONS) => {
  if (!count) {
    return [];
  }
  const { width, height } = normalizeDimensions(dimensions);
  const step = height / (count + 1);
  return Array.from({ length: count }, (_, index) => ({
    x: side === 'input' ? 0 : width,
    y: Math.round(step * (index + 1))
  }));
};

export const buildAutoPortLayout = (inputs, outputs, dimensions = DEFAULT_GATE_DIMENSIONS) => ({
  inputs: distributePorts(inputs, 'input', dimensions),
  outputs: distributePorts(outputs, 'output', dimensions)
});

export const worldToCanvas = (value) => value + HALF_WORKSPACE;
export const canvasToWorld = (value) => value - HALF_WORKSPACE;
export const worldPointToCanvas = (point) => ({
  x: worldToCanvas(point.x),
  y: worldToCanvas(point.y)
});
