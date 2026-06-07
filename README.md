# Battery Pack Designer

A visual tool for designing series/parallel battery packs. Drop cells on the
canvas, wire their **+** and **−** terminals together, and the pack spec —
voltage, capacity, energy, and the `S×P` configuration — updates live from the
actual wiring topology.

## Why it's not just a cell counter

The core is a real electrical topology engine ([`src/topology.js`](src/topology.js)):

- Wires merge terminals into electrical **nets** (union-find).
- Cells become edges between nets; **series/parallel reduction** collapses the
  graph the same way you would by hand.
- Series connections add **voltage**; parallel connections add **capacity**;
  a series chain's capacity is limited by its **weakest link**.
- **Energy (Wh)** is shown as a topology-independent cross-check (Σ cell V×Ah).

It also flags the mistakes that matter when you actually weld a pack:

- **Dead shorts** (a cell's + and − reach the same net)
- **Reversed cells** in a parallel group (they'll dump current into each other)
- **Mismatched-voltage parallels** (heavy balancing current)
- **Stray / disconnected** cells not wired into the main pack

## Usage

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # topology engine unit tests
npm run build
```

- **Click** a cell to select · **Ctrl/⌘+click** to multi-select
- **Drag a +/− node** onto another cell's node to wire them (drag the same pair again to remove)
- **Create grid** builds an `R×C` pack pre-wired as `RSxCP`
- Edit chemistry (Li-ion, LiFePO₄, NiMH, lead-acid…), cell size, V and Ah in the side panel
- **Del** removes selected · scroll to zoom · right-drag to pan · Undo/Redo (⌘Z / ⌘⇧Z)

### Physical view
Connections render as the **nickel strips you'd actually weld** — one strip per
series level (B+, each shared junction, B−), with a tab from every cell. The
**BMS overlay** marks each balance tap on its strip.

### Save / load / export
- Designs **auto-save** to the browser (restored on reload)
- **Save** / **Open** a design as JSON
- **Image** exports the diagram as a vector SVG
- **Specs** shows the pack spec + bill of materials, with **Print / PDF**

## Layout

| File | Role |
|------|------|
| [`src/topology.js`](src/topology.js) | Pure electrical engine — `analyzePack(cells, connections)` |
| [`src/topology.test.js`](src/topology.test.js) | Engine unit tests (series, parallel, S×P, faults) |
| [`src/BatteryPackDesigner.jsx`](src/BatteryPackDesigner.jsx) | Canvas UI, wiring, grid builder, side panel |
