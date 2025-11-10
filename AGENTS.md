# Logic Circuit Lab — AGENTS Playbook

This brief explains how to extend the Logic Circuit Lab application that ships with the Bespoke generalized components. Use it as the single source of truth for project scope, file structure, and code style.

---

## 1. Project Overview
- **Goal**: Deliver an embeddable circuit playground that feels native inside any host site by relying on the `.bespoke` design system for UI consistency.
- **Client** (`client/`): Contains the HTML shell, Bespoke CSS, gate assets, logic simulator, help content, and integration tests (`test-integration.html`).
- **Server** (`server.js`): Node.js (CommonJS) server that serves static assets, handles VHDL exports, and relays `/message` broadcasts via WebSockets (`ws` dependency).
- **Utilities**: `circuit-report.js` summarizes each VHDL export; data files such as `initial_state.json` and `gate-config.json` seed the canvas and palette.

---

## 2. Repository Layout & Required Artifacts

| Path | Purpose |
| --- | --- |
| `client/index.html` | Bespoke application shell (header, status, canvas, sidebar, help trigger). |
| `client/bespoke.css` | Core Bespoke framework — never edit variables here, only override. |
| `client/logic-sim.js` | Canvas rendering, drag/drop, wiring, simulation, persistence, exports. |
| `client/logic-sim.css` | Circuit-specific styling layered on top of Bespoke tokens. |
| `client/help-modal.js` | Help modal utility (import from all apps). |
| `client/help-content-template.html` | Source for modal copy; fetched at runtime. |
| `client/gate-registry.js`, `client/gates/*.svg` | Gate definitions, icons, logic functions. |
| `client/gate-config.json` | Palette order, export report toggles, default zoom, etc. |
| `client/initial_state.json` | Starter board loaded on first run or after reset. |
| `server.js` | Static server plus `/vhdl/export` and `/message` endpoints. |

### Mandatory File Order
Every embedded application must expose the following files (and keep them in this load order):
1. `bespoke.css`
2. `help-modal.js`
3. `app.js` (application logic)
4. `server.js`

---

## 3. Styling with Bespoke CSS

1. Always apply the `.bespoke` scope (usually on the `<body>` or outermost `<div>`).
2. Use only the provided CSS custom properties for colors, spacing, typography, borders, and shadows:
   - Colors: `--bespoke-bg`, `--bespoke-fg`, `--bespoke-accent`, `--bespoke-muted`, `--bespoke-box`, `--bespoke-danger`, etc.
   - Spacing: `--bespoke-space-xs` … `--bespoke-space-2xl`
   - Typography: `--bespoke-font-size-*`, `--bespoke-font-weight-*`
   - Borders & radius: `--bespoke-stroke`, `--bespoke-radius-sm|md|lg|xl`
   - Shadows: `--bespoke-shadow-sm|md|lg|xl`
3. Put overrides in app-specific files (e.g., `logic-sim.css`), never inside `bespoke.css`.
4. Name CSS files in kebab-case (`logic-sim.css`, `gate-palette.css`).
5. Theme-specific tweaks should be implemented by overriding tokens on `.bespoke`.

**CSS example**
```css
.bespoke {
  --bespoke-bg: #101217;
  --bespoke-accent: #56ccf2;
}

.canvas-grid {
  background-image: linear-gradient(var(--grid-color) 1px, transparent 1px);
  box-shadow: var(--bespoke-shadow-lg);
  border-radius: var(--bespoke-radius-lg);
}
```

---

## 4. Client Logic & Status Flow

### Help Modal
```js
import HelpModal from './help-modal.js';

const helpCopy = await fetch('./help-content-template.html').then(r => r.text());
new HelpModal({
  triggerSelector: '#btn-help',
  content: helpCopy,
  theme: 'auto',
});
```

### Status Messaging
Use `setStatus()` and only these strings:
- `Ready`
- `Loading...`
- `Saving...`
- `Changes saved`
- `Save failed (will retry)`
- `Failed to load data`
- `Auto-save initialized`

### Error Handling & Persistence
1. Wrap every async workflow in `try/catch`; log errors via `console.error`.
2. Provide useful UI feedback inside `catch` blocks.
3. Implement retry logic for network calls (e.g., exponential/backoff for `/vhdl/export`).
4. Trap and handle `localStorage` quota errors; keep the in-memory canvas running if persistence fails.
5. Validate data before writes (e.g., snapshot schema, gate payloads).

### Auto-Save Expectations
- Debounce saves, call `setStatus('Saving...')`, and show `Changes saved` on success.
- If a save fails, surface `Save failed (will retry)` and schedule the retry.

---

## 5. Server & Export Workflow
- `GET /` serves everything under `client/`.
- `POST /vhdl/export` expects `{ vhdl: string, state: object }`, writes `user.vhdl` + `state.json`, and triggers `circuit-report.js`.
- `POST /message` broadcasts `{"message":"..."}` to all WebSocket clients (requires `ws`).
- WebSockets become available automatically when `ws` is installed; clients alert incoming messages.
- Client exports are initiated via `window.logicSim.exportToVhdl()`, a `logic-sim:export-vhdl` event, or a parent `postMessage`.

---

## 6. Code Style Guidelines & Examples

### JavaScript
- Prefer ES modules in `client/` (use `import`/`export`), CommonJS in `server.js`.
- Use `const`/`let` (no `var`). Default to `const`.
- Keep functions pure when possible; isolate DOM mutations.
- Always guard async calls with `try/catch` and propagate meaningful errors.
- Document non-trivial flows with short comments (avoid restating obvious code).
- Keep filenames in kebab-case (`logic-sim.js`, `help-modal.js`).

```js
export async function loadInitialState() {
  setStatus('Loading...');
  try {
    const res = await fetch('./initial_state.json');
    if (!res.ok) throw new Error('Starter circuit unavailable');
    const state = await res.json();
    setStatus('Ready');
    return state;
  } catch (error) {
    console.error('[loadInitialState]', error);
    setStatus('Failed to load data');
    throw error;
  }
}
```

### CSS
- Scope selectors under `.bespoke` whenever the rule affects the shared UI.
- Use spacing helpers instead of hard-coded pixels (`padding: var(--bespoke-space-lg)`).
- Favor utility classes from Bespoke before adding new ones; if you add custom classes, prefix them with the component name (`.canvas-toolbar`, `.palette-card`).

```css
.bespoke .palette-card {
  display: flex;
  gap: var(--bespoke-space-sm);
  border: 1px solid var(--bespoke-stroke);
}
```

### HTML
- Keep semantics intact: use `<header>`, `<main>`, `<aside>`, `<section>`, `<button>`, `<form>`, etc.
- Preserve ARIA attributes and keyboard access (button elements instead of `<div>`).
- Reference scripts at the end of the body and maintain the documented order.

```html
<header class="header">
  <h1>Logic Circuit Lab</h1>
  <div class="status" id="status">Ready</div>
  <button id="btn-help" class="as-button ghost">Help</button>
</header>
```

---

## 8. Reference Assets
- `client/help-content-template.html` — duplicate sections to document new tools or grading rubrics.
- `client/starter.vhdl` — sample output; overwrite once exports are validated.
- `circuit-report.js` — adjust report toggles via `client/gate-config.json`.

Follow this playbook whenever you add new features, help content, or integrations so the Bespoke components remain consistent across every embedded deployment of Logic Circuit Lab.
