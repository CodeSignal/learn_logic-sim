# Logic Circuit Lab

Logic Circuit Lab is a browser-based playground for sketching, simulating, and exporting small digital circuits. The UI is built on the Bespoke generalized components so it can be embedded anywhere, while a lightweight Node.js server serves the app, handles VHDL exports, and exposes a simple messaging API.

---

## What’s Inside
- `client/index.html` – the full Bespoke application (header, palette, canvas, inspector, help trigger).
- `client/logic-sim.js` – canvas rendering, drag/drop, wiring, evaluation, auto-save, export helpers.
- `client/logic-sim.css` – circuit-specific styling layered on top of `client/bespoke.css`.
- `client/gate-registry.js` & `client/gates/*.svg` – built-in gate definitions, icons, and logic.
- `client/help-modal.js` & `client/help-content-template.html` – Help modal framework and copy.
- `client/initial_state.json` – starter circuit loaded on first launch or after reset.
- `client/gate-config.json` – palette ordering, default zoom, and export-report options.
- `server.js` – static file server, `/vhdl/export` handler, `/message` relay, optional WebSocket hub.
- `circuit-report.js` – pretty printer that summarizes each export to the console.

---

## Features at a Glance
- Drag gates from the palette or click to drop them at the center of the viewport.
- Wire outputs to inputs with a click/tap workflow; wires snap to ports and redraw as you move gates.
- Real-time simulation with deterministic propagation and cached inputs to avoid oscillations.
- Selection panel with gate metadata, label editing, and context actions (toggle inputs, delete, etc.).
- Infinite workspace with smooth pan (drag on empty canvas) and wheel-based zoom (Ctrl+wheel for precision).
- Auto-save to `localStorage` with standardized Bespoke status messaging (`Ready`, `Saving...`, etc.).
- Reset button reloads `initial_state.json` and re-primes auto-save.
- Help modal content streamed from `help-content-template.html` and triggered by the header Help button.
- One-click (or scripted) VHDL export that posts the circuit snapshot to the Node server.

---

## Getting Started
1. **Install prerequisites** – Node.js 18+ and npm.
2. **Install dependencies** – Run `npm install` if you need to add/refresh modules.
3. **Start the dev server**
   ```bash
   npm start
   ```
   The server listens on `http://localhost:3000` and serves the contents of `client/`.
4. **Open the app** – visit `http://localhost:3000` to launch Logic Circuit Lab.
5. **Optional: broadcast a message**
   ```bash
   curl -X POST http://localhost:3000/message \
     -H "Content-Type: application/json" \
     -d '{"message":"Hello lab!"}'
   ```
   Requires the `ws` dependency to be installed; all connected clients will display the alert.

---

## Using the Interface
- **Palette (left sidebar)** – click a gate to drop it at the center, or drag it directly into the canvas. Available gates include Input, Output, Buffer, NOT, AND, NAND, OR, NOR, and XOR; extend the list via `gate-registry.js`.
- **Canvas** – drag on empty space to pan, use the mouse wheel (or pinch gesture) to zoom, and click a gate to select it. Press Delete/Backspace to remove the active gate. Selection outlines show connection points; ports highlight when valid wiring targets are available.
- **Wiring workflow** – click an output port, then click a compatible input port. A ghost wire follows your cursor until you pick a destination. Clicking an occupied input rewires it to the new source.
- **Inputs and outputs** – input gates act as toggles; click them (or use the inspector action) to switch between 0/1. Output gates display the live signal coming into their single input.
- **Inspector (Selection card)** – shows the currently selected gate’s properties, allows renaming labels, exposes gate-specific actions, and lists every connected port.
- **Reset** – the “Reset” button above the canvas replaces the board with `initial_state.json` and reinitializes auto-save.
- **Help** – the `Help` button in the header opens the modal populated from `help-content-template.html`. Update that file to document your specific lab instructions, keyboard shortcuts, or grading rubric.

---

## Custom Gates
- Custom gates are described through `.json` snapshots that match the `state.json` schema (the object returned by `window.logicSim.snapshot()`).
- Build a circuit with the standard palette, export it via `window.logicSim.snapshot()` (or copy `state.json`), and drop that JSON file into `client/custom-gates/` to turn it into a reusable gate without duplicating its contents.
- Input and output pins for the custom gate are inferred from the `input` and `output` gates inside the JSON snapshot (their labels become the exposed port names). Simulation treats the custom gate as a black box by running the nested snapshot with the same propagation engine.
- Snapshots embedded in saved circuits (or discovered under `client/custom-gates/`) automatically appear in the main palette alongside the built-in gates.
- VHDL exports automatically flatten any custom gates, so you can keep them in your design and still obtain a complete netlist while `state.json` preserves the original snapshot (including custom gate definitions).

---

## Saving, Loading, and Status Messages
- On first load, `logic-sim.js` fetches `initial_state.json`, applies it to the canvas, and caches it locally.
- Once the app confirms that `localStorage` works, every mutation is debounced (500 ms) and saved under the key `logic-circuit-lab-state-v1`.
- Status changes are limited to the mandated Bespoke messages; `setStatus()` is exposed globally for future integrations.
- If persistence fails (quota exceeded, private mode, etc.), the app logs the error, shows `Failed to load data`, and keeps the in-memory circuit running.
- Resetting the canvas writes the starter snapshot back to storage, ensuring the pool stays in sync across reloads.

---

## Exporting to VHDL
1. Trigger an export by running one of the following in DevTools or from a parent frame:
   ```javascript
   window.logicSim.exportToVhdl();
   // or
   window.dispatchEvent(new Event('logic-sim:export-vhdl'));
   // or
   window.postMessage({ type: 'logic-sim:export-vhdl' }, '*');
   ```
2. The client serializes the current snapshot to VHDL, then POSTs:
   ```json
   {
     "vhdl": "<generated code>",
     "state": { ...current circuit snapshot... },
     "exportState": { ...flattened export snapshot... }
   }
   ```
   to `POST /vhdl/export`.
3. The server writes `user.vhdl` and `state.json` at the repo root, then runs `circuit-report.printCircuitReport()` to log counts, positions, connection issues, and (optionally) a truth table. Report sections are toggled via `gate-config.json > exportReport`.
4. If the request fails, the client shows `Save failed (will retry)` and automatically retries after 3 s.

---

## Configuration & Data Files
- **`client/gate-config.json`**
  - `defaultZoom` – initial canvas scale (clamped between 0.5 and 2.75).
  - `paletteOrder` – ordered list of gate type keys from `gate-registry.js`.
  - `exportReport` – toggles for each console report section plus truth-table limits.
- **`client/initial_state.json`**
  - Defines the starter circuit (`gates`, `connections`, `nextId`). Edit coordinates, labels, or states to showcase a different demo when the app loads.
- **`client/gate-registry.js`**
  - Extend `registerGate()` calls to add new gate types. Provide an SVG icon, `inputs`, `outputs`, port layout, and a pure logic function that returns output bits.
- **`client/logic-sim.css`**
  - Customize colors, gate chrome, canvas grid, inspector layout, etc. Keep theme tokens (`--bespoke-*`) to remain compatible with host pages.
- **`client/help-content-template.html`**
  - Replace placeholders with real instructions. The file is fetched as text, so inline images should use relative paths inside `client/`.

---

## Server API & Messaging
- `GET /` (and static assets) – serves files from `client/`.
- `POST /vhdl/export` – accepts `{ vhdl: string, state: object, exportState?: object }`, writes artifacts, prints reports, responds with `{ success: true }` on success.
- `POST /message` – accepts `{ message: string }`, broadcasts it to every connected WebSocket client (`ws` package required). Clients show an alert with the message body.
- WebSockets – automatically enabled when the `ws` dependency is installed. Connections are logged, and messages flow only from `/message` to the clients; there is no inbound command channel yet.

---

## Embedding & Automation Hooks
- The canvas exposes `window.logicSim` with:
  - `exportToVhdl()` – triggers the export flow described above.
  - `snapshot()` – returns the current normalized circuit state.
  - `resetToStarter()` – programmatically mirrors the Reset button.
- Custom exporters can listen for `message` events (`event.data.type === 'logic-sim:export-vhdl'`) or dispatch the `logic-sim:export-vhdl` DOM event.
- The app uses standard Bespoke status messaging and `.bespoke` scoping, so you can embed `client/index.html` inside `test-integration.html` or another host without style collisions.
