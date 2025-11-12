#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { serializeSnapshotToVhdl } = require('../vhdl-serializer');
const { printCircuitReport } = require('../circuit-report');

const ROOT_DIR = path.resolve(__dirname, '..');
const GATE_CONFIG_PATH = path.join(ROOT_DIR, 'client', 'gate-config.json');

async function loadJSON(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function loadGateConfig() {
  try {
    return await loadJSON(GATE_CONFIG_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to load gate-config.json: ${error.message}`);
    }
    return {};
  }
}

function resolvePath(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.join(ROOT_DIR, inputPath);
}

function buildVhdlDestination(jsonPath) {
  const dir = path.dirname(jsonPath);
  const base = path.basename(jsonPath, path.extname(jsonPath) || '.json');
  return path.join(dir, `${base}.vhdl`);
}

async function exportSnapshot(jsonInputPath, gateConfig) {
  const state = await loadJSON(jsonInputPath);
  const vhdl = serializeSnapshotToVhdl(state);
  const vhdlPath = buildVhdlDestination(jsonInputPath);

  await Promise.all([
    fs.writeFile(jsonInputPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8'),
    fs.writeFile(vhdlPath, `${vhdl.trimEnd()}\n`, 'utf8')
  ]);

  try {
    printCircuitReport(state, gateConfig);
  } catch (reportError) {
    console.warn(`Failed to generate circuit report for ${path.basename(jsonInputPath)}: ${reportError.message}`);
  }

  return vhdlPath;
}

async function run() {
  const args = process.argv.slice(2);
  let starterInput = 'starter.json';
  let solutionInput = 'solution.json';

  if (args.length === 2) {
    [starterInput, solutionInput] = args;
  } else if (args.length !== 0) {
    console.error('Usage: node scripts/export-task-state.js <starter.json> <solution.json>');
    process.exitCode = 1;
    return;
  }

  try {
    const gateConfig = await loadGateConfig();

    const starterPath = resolvePath(starterInput);
    const solutionPath = resolvePath(solutionInput);

    const starterVhdlPath = await exportSnapshot(starterPath, gateConfig);
    console.log(`Starter export complete: ${path.relative(ROOT_DIR, starterVhdlPath)}`);

    const solutionVhdlPath = await exportSnapshot(solutionPath, gateConfig);
    console.log(`Solution export complete: ${path.relative(ROOT_DIR, solutionVhdlPath)}`);
  } catch (error) {
    console.error('Failed to export task states:', error);
    process.exitCode = 1;
  }
}

run();
