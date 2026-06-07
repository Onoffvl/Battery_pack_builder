import React, { useState, useRef, useEffect, useCallback } from 'react';
import { analyzePack, computeBMSTaps, computeNets } from './topology.js';

const CELL_W = 60;
const CELL_H = 90;
const NODE_R = 7;
const NODE_GAP = 14; // distance from a cell edge to its terminal node centre

const CHEMISTRIES = [
  { id: 'liion', name: 'Li-ion (NMC)', voltage: 3.7 },
  { id: 'lifepo4', name: 'LiFePO₄', voltage: 3.2 },
  { id: 'lipo', name: 'LiPo', voltage: 3.7 },
  { id: 'nimh', name: 'NiMH', voltage: 1.2 },
  { id: 'lead', name: 'Lead-acid', voltage: 2.0 },
];
const CELL_SIZES = [
  { name: '18650', capacity: 3.5 },
  { name: '21700', capacity: 5.0 },
  { name: '26650', capacity: 5.0 },
  { name: '32700', capacity: 6.0 },
  { name: 'Pouch', capacity: 10 },
];

const makeCell = (id, x, y, over = {}) => ({
  id, x, y, voltage: 3.7, capacity: 5, flipped: false, ...over,
});

export default function BatteryPackDesigner() {
  const [cells, setCells] = useState([makeCell(1, 120, 180)]);
  const [connections, setConnections] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [nextId, setNextId] = useState(2);

  const [history, setHistory] = useState([{ cells: [makeCell(1, 120, 180)], connections: [] }]);
  const [histIndex, setHistIndex] = useState(0);

  const [draggingLine, setDraggingLine] = useState(null); // { from, fromPole }
  const [pointer, setPointer] = useState({ x: 0, y: 0 });  // canvas-space pointer
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);

  const [gridModal, setGridModal] = useState(false);
  const [gridRows, setGridRows] = useState(3);
  const [gridCols, setGridCols] = useState(4);
  const [showBMS, setShowBMS] = useState(true);
  const [summaryModal, setSummaryModal] = useState(false);
  const fileRef = useRef(null);

  const canvasRef = useRef(null);
  const panRef = useRef(pan);
  panRef.current = pan;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // ---- history ------------------------------------------------------------
  // Single source of truth for mutations: set both pieces of state AND record
  // a history entry atomically, so snapshots never lag the visible state.
  const commit = useCallback((nextCells, nextConnections) => {
    setCells(nextCells);
    setConnections(nextConnections);
    setHistory((h) => {
      const trimmed = h.slice(0, histIndexRef.current + 1);
      trimmed.push({ cells: nextCells, connections: nextConnections });
      const capped = trimmed.slice(-100);
      histIndexRef.current = capped.length - 1;
      setHistIndex(capped.length - 1);
      return capped;
    });
  }, []);

  const histIndexRef = useRef(0);
  histIndexRef.current = histIndex;

  const undo = useCallback(() => {
    if (histIndexRef.current <= 0) return;
    const idx = histIndexRef.current - 1;
    const snap = history[idx];
    setCells(snap.cells);
    setConnections(snap.connections);
    setHistIndex(idx);
    histIndexRef.current = idx;
  }, [history]);

  const redo = useCallback(() => {
    if (histIndexRef.current >= history.length - 1) return;
    const idx = histIndexRef.current + 1;
    const snap = history[idx];
    setCells(snap.cells);
    setConnections(snap.connections);
    setHistIndex(idx);
    histIndexRef.current = idx;
  }, [history]);

  // ---- geometry -----------------------------------------------------------
  const poleSide = (cell, pole) => {
    const topIsPlus = !cell.flipped;
    if (pole === '+') return topIsPlus ? 'top' : 'bottom';
    return topIsPlus ? 'bottom' : 'top';
  };
  const nodePos = (cellId, pole) => {
    const cell = cells.find((c) => c.id === cellId);
    if (!cell) return null;
    const side = poleSide(cell, pole);
    const y = side === 'top' ? cell.y - NODE_GAP : cell.y + CELL_H + NODE_GAP;
    return { x: cell.x + CELL_W / 2, y };
  };

  // Screen → world coordinates (undo pan, then undo zoom).
  const toCanvas = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const z = zoomRef.current;
    return {
      x: (clientX - rect.left - panRef.current.x) / z,
      y: (clientY - rect.top - panRef.current.y) / z,
    };
  };

  // ---- cell ops -----------------------------------------------------------
  const addCell = () => {
    const c = makeCell(nextId, 140 + (cells.length % 6) * 30, 160 + Math.floor(cells.length / 6) * 30);
    setNextId(nextId + 1);
    commit([...cells, c], connections);
  };

  const flipSelected = () => {
    if (!selected.size) return;
    commit(cells.map((c) => (selected.has(c.id) ? { ...c, flipped: !c.flipped } : c)), connections);
  };

  const deleteSelected = useCallback(() => {
    if (!selected.size) return;
    const nextCells = cells.filter((c) => !selected.has(c.id));
    const nextConns = connections.filter((cn) => !selected.has(cn.from) && !selected.has(cn.to));
    setSelected(new Set());
    commit(nextCells, nextConns);
  }, [cells, connections, selected, commit]);

  const clearAll = () => {
    setSelected(new Set());
    resetView();
    commit([], []);
  };

  const updateSelected = (patch) => {
    if (!selected.size) return;
    commit(cells.map((c) => (selected.has(c.id) ? { ...c, ...patch } : c)), connections);
  };

  // ---- persistence & import/export ---------------------------------------
  const STORAGE_KEY = 'bpd:design:v1';

  // Restore the last design once on mount.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!Array.isArray(d.cells) || !Array.isArray(d.connections) || !d.cells.length) return;
      setCells(d.cells);
      setConnections(d.connections);
      setNextId(d.nextId || Math.max(0, ...d.cells.map((c) => c.id)) + 1);
      setHistory([{ cells: d.cells, connections: d.connections }]);
      setHistIndex(0);
      histIndexRef.current = 0;
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  // Auto-save on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, cells, connections, nextId }));
    } catch {
      /* storage full / unavailable */
    }
  }, [cells, connections, nextId]);

  const download = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportJSON = () =>
    download('battery-pack.json', JSON.stringify({ version: 1, cells, connections, nextId }, null, 2), 'application/json');

  const importJSON = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (!Array.isArray(d.cells) || !Array.isArray(d.connections)) throw new Error('bad shape');
        setSelected(new Set());
        resetView();
        setNextId(d.nextId || Math.max(0, ...d.cells.map((c) => c.id || 0)) + 1);
        commit(d.cells, d.connections);
      } catch {
        alert('Could not read that file — it is not a valid pack design.');
      }
    };
    reader.readAsText(file);
  };

  // ---- grid (auto-wired into S×P) ----------------------------------------
  const createGrid = () => {
    const SPX = 95;
    const SPY = 150;
    const grid = []; // grid[row][col] = id
    const newCells = [];
    let id = 1;
    for (let r = 0; r < gridRows; r++) {
      grid[r] = [];
      for (let c = 0; c < gridCols; c++) {
        // No flips: + always on top, − on bottom, so series links between rows
        // are short vertical jumps from one array straight to the next.
        newCells.push(makeCell(id, 50 + c * SPX, 50 + r * SPY));
        grid[r][c] = id;
        id++;
      }
    }
    // Wire: each row is a parallel group (cols in parallel), rows in series.
    const conns = [];
    for (let r = 0; r < gridRows; r++) {
      for (let c = 1; c < gridCols; c++) {
        conns.push({ from: grid[r][0], fromPole: '+', to: grid[r][c], toPole: '+' });
        conns.push({ from: grid[r][0], fromPole: '-', to: grid[r][c], toPole: '-' });
      }
      if (r > 0) {
        // Series to the row above: bottom (−) of the upper array → top (+) of
        // this array. One link is enough — the strip renderer draws the full
        // shared junction strip across the whole array.
        conns.push({ from: grid[r - 1][0], fromPole: '-', to: grid[r][0], toPole: '+' });
      }
    }
    setNextId(id);
    setSelected(new Set());
    resetView();
    setGridModal(false);
    commit(newCells, conns);
  };

  // ---- connections --------------------------------------------------------
  const startWire = (cellId, pole) => setDraggingLine({ from: cellId, fromPole: pole });

  const endWire = (cellId, pole) => {
    if (!draggingLine || draggingLine.from === cellId) {
      setDraggingLine(null);
      return;
    }
    const exists = connections.findIndex(
      (c) =>
        (c.from === draggingLine.from && c.fromPole === draggingLine.fromPole && c.to === cellId && c.toPole === pole) ||
        (c.to === draggingLine.from && c.toPole === draggingLine.fromPole && c.from === cellId && c.fromPole === pole)
    );
    let next;
    if (exists >= 0) {
      next = connections.filter((_, i) => i !== exists);
    } else {
      next = [...connections, { from: draggingLine.from, fromPole: draggingLine.fromPole, to: cellId, toPole: pole }];
    }
    commit(cells, next);
    setDraggingLine(null);
  };

  const removeConnection = (idx) => commit(cells, connections.filter((_, i) => i !== idx));

  // ---- selection & drag-move ---------------------------------------------
  const toggleSelect = (cellId, multi) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (multi) {
        next.has(cellId) ? next.delete(cellId) : next.add(cellId);
      } else {
        next.clear();
        next.add(cellId);
      }
      return next;
    });
  };

  const startCellDrag = (cellId, e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const multi = e.ctrlKey || e.metaKey;

    // Make sure the cell under the cursor is part of the selection we move.
    let moveSet;
    if (selected.has(cellId)) {
      moveSet = new Set(selected);
      if (multi) toggleSelect(cellId, true);
    } else {
      toggleSelect(cellId, multi);
      moveSet = multi ? new Set([...selected, cellId]) : new Set([cellId]);
    }

    // Snapshot positions at drag start and apply the *total* delta each move,
    // so there's no incremental drift and we can commit one clean history entry.
    const startCells = cells;
    const origin = { x: e.clientX, y: e.clientY };
    let totalDx = 0;
    let totalDy = 0;

    const applyDelta = () =>
      startCells.map((c) => (moveSet.has(c.id) ? { ...c, x: c.x + totalDx, y: c.y + totalDy } : c));

    const onMove = (m) => {
      // screen pixels → world units (so drag tracks the cursor at any zoom)
      const z = zoomRef.current;
      totalDx = (m.clientX - origin.x) / z;
      totalDy = (m.clientY - origin.y) / z;
      setCells(applyDelta());
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (totalDx || totalDy) commit(applyDelta(), connections);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ---- panning ------------------------------------------------------------
  const onCanvasMouseDown = (e) => {
    if (e.button !== 2 && e.button !== 1) return;
    setIsPanning(true);
    const start = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    const onMove = (m) => setPan({ x: m.clientX - start.x, y: m.clientY - start.y });
    const onUp = () => {
      setIsPanning(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Zoom about the canvas centre (used by the +/− HUD buttons).
  const zoomBy = (factor) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const z = zoomRef.current;
    const nz = Math.min(4, Math.max(0.2, z * factor));
    const wx = (mx - panRef.current.x) / z;
    const wy = (my - panRef.current.y) / z;
    setPan({ x: mx - wx * nz, y: my - wy * nz });
    setZoom(nz);
  };

  // ---- wheel zoom (centered on cursor) ------------------------------------
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const z = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nz = Math.min(4, Math.max(0.2, z * factor));
      // keep the world point under the cursor fixed on screen
      const wx = (mx - panRef.current.x) / z;
      const wy = (my - panRef.current.y) / z;
      setPan({ x: mx - wx * nz, y: my - wy * nz });
      setZoom(nz);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        deleteSelected();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteSelected, undo, redo]);

  // ---- analysis -----------------------------------------------------------
  const result = analyzePack(cells, connections);
  const energy = result.energy.toFixed(1);
  const errors = result.faults.filter((f) => f.severity === 'error');
  const warns = result.faults.filter((f) => f.severity === 'warn');

  const selectedCells = cells.filter((c) => selected.has(c.id));
  const selVoltage = selectedCells.length && selectedCells.every((c) => c.voltage === selectedCells[0].voltage)
    ? selectedCells[0].voltage : '';
  const selCapacity = selectedCells.length && selectedCells.every((c) => c.capacity === selectedCells[0].capacity)
    ? selectedCells[0].capacity : '';

  const nodeColor = (pole) => (pole === '+' ? '#43a047' : '#e53935');

  // Physical nickel strips: one per electrical net. A strip is a horizontal bar
  // sitting where the nickel would go, with a short tab welding each cell
  // terminal to it. A junction strip lands in the gap between arrays; the B+/B−
  // strips sit along the outer edges.
  const strips = computeNets(cells, connections)
    .map((net) => {
      const pts = net.terminals.map((t) => nodePos(t.cellId, t.pole)).filter(Boolean);
      if (pts.length < 2) return null;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const y = (Math.min(...ys) + Math.max(...ys)) / 2;
      return { x0: Math.min(...xs), x1: Math.max(...xs), y, pts };
    })
    .filter(Boolean);

  // BMS sense taps (one per series node). A real BMS solders its sense wire
  // onto the nickel where series groups join, so we anchor each tap to the
  // series link sitting in the open gap *between* rows — that keeps the tag off
  // the cells. The two pack ends (B−/B+) only have an outer busbar, so their
  // tags get pushed clear of the pack instead.
  const bmsTaps = showBMS ? computeBMSTaps(cells, connections) : [];
  const tapLabel = (i) => (i === 0 ? 'B−' : i === bmsTaps.length - 1 ? 'B+' : `S${i}`);

  const packMidY = cells.length
    ? cells.reduce((s, c) => s + c.y + CELL_H / 2, 0) / cells.length
    : 0;

  const tapMark = (tap) => {
    // Place the tap on its strip: same y as the strip, in the gap between the
    // first two cells so the dot sits on the nickel, not on a battery.
    const pts = tap.terminals.map((t) => nodePos(t.cellId, t.pole)).filter(Boolean);
    if (!pts.length) return null;
    const ys = pts.map((p) => p.y);
    const stripY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const xs = [...new Set(pts.map((p) => p.x))].sort((a, b) => a - b);
    const dot = { x: xs.length >= 2 ? (xs[0] + xs[1]) / 2 : xs[0], y: stripY };

    // Push the voltage tag clear: junctions → into the gap above the strip;
    // the B+/B− end strips → outward from the pack.
    const isJunction = Math.max(...ys) - Math.min(...ys) > 4;
    const dir = isJunction || stripY < packMidY ? -1 : 1;
    return { dot, label: { x: dot.x, y: dot.y + dir * 20 }, anchor: 'middle', stub: dir };
  };

  // Bill of materials: cells grouped by chemistry/voltage/capacity.
  const bom = (() => {
    const map = new Map();
    cells.forEach((c) => {
      const k = `${c.voltage}|${c.capacity}`;
      map.set(k, (map.get(k) || 0) + 1);
    });
    return [...map.entries()].map(([k, n]) => {
      const [v, ah] = k.split('|').map(Number);
      return { voltage: v, capacity: ah, count: n };
    });
  })();

  // Export the diagram as a standalone SVG (vector, prints cleanly).
  const exportSVG = () => {
    if (!cells.length) return;
    const pad = 70;
    const minX = Math.min(...cells.map((c) => c.x)) - pad;
    const minY = Math.min(...cells.map((c) => c.y)) - pad;
    const maxX = Math.max(...cells.map((c) => c.x + CELL_W)) + pad;
    const maxY = Math.max(...cells.map((c) => c.y + CELL_H)) + pad;
    const W = Math.round(maxX - minX);
    const H = Math.round(maxY - minY);
    const ox = (x) => Math.round(x - minX);
    const oy = (y) => Math.round(y - minY);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">`;
    s += `<rect width="${W}" height="${H}" fill="#fafafa"/>`;
    strips.forEach((st) => {
      st.pts.forEach((p) => {
        s += `<line x1="${ox(p.x)}" y1="${oy(p.y)}" x2="${ox(p.x)}" y2="${oy(st.y)}" stroke="#90a4ae" stroke-width="5" stroke-linecap="round"/>`;
      });
      s += `<line x1="${ox(st.x0 - 8)}" y1="${oy(st.y)}" x2="${ox(st.x1 + 8)}" y2="${oy(st.y)}" stroke="#b0bec5" stroke-width="9" stroke-linecap="round"/>`;
      s += `<line x1="${ox(st.x0 - 8)}" y1="${oy(st.y)}" x2="${ox(st.x1 + 8)}" y2="${oy(st.y)}" stroke="#78909c" stroke-width="3" stroke-linecap="round"/>`;
    });
    cells.forEach((c) => {
      const x = ox(c.x);
      const y = oy(c.y);
      s += `<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" rx="8" fill="#1e88e5" stroke="#1565c0" stroke-width="2"/>`;
      s += `<text x="${x + CELL_W / 2}" y="${y + CELL_H / 2 - 6}" text-anchor="middle" font-size="10" fill="#fff">Cell ${c.id}</text>`;
      s += `<text x="${x + CELL_W / 2}" y="${y + CELL_H / 2 + 11}" text-anchor="middle" font-size="11" font-weight="bold" fill="#fff">${c.voltage}V ${c.capacity}Ah</text>`;
      ['+', '-'].forEach((pole) => {
        const np = nodePos(c.id, pole);
        if (np) s += `<circle cx="${ox(np.x)}" cy="${oy(np.y)}" r="6" fill="${pole === '+' ? '#43a047' : '#e53935'}" stroke="#fff" stroke-width="2"/>`;
      });
    });
    if (showBMS) {
      bmsTaps.forEach((tap) => {
        const m = tapMark(tap);
        if (m) s += `<circle cx="${ox(m.dot.x)}" cy="${oy(m.dot.y)}" r="5" fill="#8e24aa" stroke="#fff" stroke-width="2"/>`;
      });
    }
    s += `</svg>`;
    download('battery-pack.svg', s, 'image/svg+xml');
  };

  // Open a printable spec sheet + BOM in a new window (Save as PDF from there).
  const printSummary = () => {
    const rows = bom
      .map((b) => `<tr><td>${b.count}×</td><td>${b.voltage} V</td><td>${b.capacity} Ah</td></tr>`)
      .join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Battery pack spec</title>
      <style>body{font-family:sans-serif;padding:2rem;color:#222}h1{font-size:20px}
      table{border-collapse:collapse;margin-top:.5rem}td,th{border:1px solid #ccc;padding:6px 12px;text-align:left;font-size:13px}
      .specs{display:flex;gap:1.5rem;margin:1rem 0;font-size:14px}.specs b{display:block;font-size:20px}</style></head><body>
      <h1>Battery pack specification</h1>
      <div class="specs">
        <div><b>${result.label || '—'}</b>configuration</div>
        <div><b>${result.voltage.toFixed(1)} V</b>voltage</div>
        <div><b>${result.capacity.toFixed(1)} Ah</b>capacity</div>
        <div><b>${result.energy.toFixed(1)} Wh</b>energy</div>
      </div>
      <p>${result.cellCount} cells · ${bmsTaps.length} BMS balance leads</p>
      <h3>Bill of materials</h3>
      <table><tr><th>Qty</th><th>Voltage</th><th>Capacity</th></tr>${rows}</table>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div className="designer">
      {/* Toolbar */}
      <div className="toolbar">
        <button className="btn" onClick={addCell}>+ Add cell</button>
        <button className="btn" onClick={() => setGridModal(true)}>⊞ Create grid</button>
        {selected.size > 0 && (
          <>
            <button className="btn warn" onClick={flipSelected}>⟲ Flip ({selected.size})</button>
            <button className="btn danger" onClick={deleteSelected}>🗑 Delete ({selected.size})</button>
          </>
        )}
        <button className="btn ghost" onClick={clearAll}>Clear</button>
        <button className={`btn ${showBMS ? '' : 'ghost'}`} style={showBMS ? { background: '#8e24aa' } : undefined} onClick={() => setShowBMS((v) => !v)}>
          {showBMS ? '◉' : '○'} BMS
        </button>
        <div className="spacer" />
        <div className="group">
          <button className="btn secondary" onClick={() => fileRef.current?.click()} title="Open a saved design">Open</button>
          <button className="btn secondary" onClick={exportJSON} title="Download design as JSON">Save</button>
          <button className="btn secondary" onClick={exportSVG} title="Export diagram as SVG">Image</button>
          <button className="btn secondary" onClick={() => setSummaryModal(true)} title="Spec sheet & parts list">Specs</button>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={importJSON} style={{ display: 'none' }} />
        <div className="group">
          <button className="btn secondary" onClick={undo} disabled={histIndex <= 0}>↶ Undo</button>
          <button className="btn secondary" onClick={redo} disabled={histIndex >= history.length - 1}>↷ Redo</button>
        </div>
      </div>

      <div className="hint">
        Click a cell to select · <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+click to multi-select · drag a <span style={{ color: '#43a047' }}>+</span>/<span style={{ color: '#e53935' }}>−</span> node onto another to wire · click a wire to remove it · <kbd>Del</kbd> deletes selected · scroll to zoom · right-drag to pan
      </div>

      <div className="workspace">
        {/* Canvas */}
        <div
          ref={canvasRef}
          className="canvas"
          style={{ cursor: isPanning ? 'grabbing' : 'default' }}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={(e) => setPointer(toCanvas(e.clientX, e.clientY))}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* One transformed "world" layer: everything pans and zooms together */}
          <div
            className="world"
            style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, transformOrigin: '0 0', transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            <svg style={{ position: 'absolute', overflow: 'visible', width: 1, height: 1, pointerEvents: 'none' }}>
              {/* Physical nickel strips: one bar per net, with a tab welding each
                  cell terminal to it — what you'd actually cut and weld. */}
              {strips.map((s, idx) => (
                <g key={`strip-${idx}`}>
                  {s.pts.map((p, j) => (
                    <line key={j} x1={p.x} y1={p.y} x2={p.x} y2={s.y} stroke="#90a4ae" strokeWidth="5" strokeLinecap="round" />
                  ))}
                  <line x1={s.x0 - 8} y1={s.y} x2={s.x1 + 8} y2={s.y} stroke="#b0bec5" strokeWidth="9" strokeLinecap="round" />
                  <line x1={s.x0 - 8} y1={s.y} x2={s.x1 + 8} y2={s.y} stroke="#78909c" strokeWidth="3" strokeLinecap="round" />
                </g>
              ))}
              {draggingLine && (() => {
                const a = nodePos(draggingLine.from, draggingLine.fromPole);
                if (!a) return null;
                return <line x1={a.x} y1={a.y} x2={pointer.x} y2={pointer.y} stroke="#90a4ae" strokeWidth="2.5" strokeDasharray="6,5" />;
              })()}
            </svg>

            {cells.map((cell) => {
              const isSel = selected.has(cell.id);
              const topPole = poleSide(cell, '+') === 'top' ? '+' : '-';
              const botPole = topPole === '+' ? '-' : '+';
              return (
                <div key={cell.id} style={{ position: 'absolute', left: cell.x, top: cell.y }}>
                  <div
                    onMouseDown={(e) => startCellDrag(cell.id, e)}
                    style={{
                      width: CELL_W, height: CELL_H,
                      background: isSel ? '#1565c0' : '#1e88e5',
                      border: isSel ? '3px solid #0d47a1' : '2px solid #1565c0',
                      borderRadius: 8, display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', color: '#fff',
                      cursor: 'grab', fontSize: 12, fontWeight: 700,
                      boxShadow: isSel ? '0 6px 16px rgba(13,71,161,0.4)' : '0 2px 8px rgba(0,0,0,0.18)',
                    }}
                  >
                    <div style={{ fontSize: 10, opacity: 0.85 }}>Cell {cell.id}</div>
                    <div style={{ fontSize: 13, marginTop: 4, textAlign: 'center', lineHeight: 1.3 }}>
                      {cell.voltage.toFixed(1)}V<br />{cell.capacity}Ah
                    </div>
                  </div>
                  {[['top', topPole], ['bottom', botPole]].map(([side, pole]) => (
                    <React.Fragment key={side}>
                      {/* terminal lead: a short stub from the battery edge to the
                          node, so the busbar visibly connects to the cell */}
                      <div style={{
                        position: 'absolute', left: CELL_W / 2 - 2, width: 4, height: NODE_GAP,
                        [side === 'top' ? 'top' : 'bottom']: -NODE_GAP,
                        background: '#546e7a',
                      }} />
                      <div
                        onMouseDown={(e) => { e.stopPropagation(); startWire(cell.id, pole); }}
                        onMouseUp={(e) => { e.stopPropagation(); endWire(cell.id, pole); }}
                        onMouseEnter={() => draggingLine && endWire(cell.id, pole)}
                        title={`${pole} terminal`}
                        style={{
                          position: 'absolute', left: CELL_W / 2 - NODE_R, width: NODE_R * 2, height: NODE_R * 2,
                          [side === 'top' ? 'top' : 'bottom']: -NODE_GAP - NODE_R,
                          borderRadius: '50%', background: nodeColor(pole), border: '2px solid #fff',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.3)', cursor: 'crosshair',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#fff', fontSize: 11, fontWeight: 700, lineHeight: 1,
                        }}
                      >
                        {pole}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              );
            })}

            {/* BMS overlay — drawn last so the taps sit on top of the cells.
                A dot soldered onto the nickel where series groups join, with the
                voltage tag offset into clear space. */}
            <svg style={{ position: 'absolute', overflow: 'visible', width: 1, height: 1, pointerEvents: 'none', zIndex: 5 }}>
              {bmsTaps.map((tap, i) => {
                const m = tapMark(tap);
                if (!m) return null;
                const isEnd = i === 0 || i === bmsTaps.length - 1;
                const text = isEnd ? `${tapLabel(i)} ${tap.voltage.toFixed(1)}V` : tap.voltage.toFixed(1) + 'V';
                const w = isEnd ? 62 : 38;
                const tagX = m.anchor === 'middle' ? m.label.x - w / 2 : m.label.x;
                return (
                  <g key={`bms-${tap.net}`}>
                    {m.stub !== 0 && (
                      <line x1={m.dot.x} y1={m.dot.y} x2={m.label.x} y2={m.label.y - (m.stub < 0 ? -8 : 8)}
                        stroke="#ab47bc" strokeWidth="2" />
                    )}
                    <circle cx={m.dot.x} cy={m.dot.y} r={isEnd ? 6 : 5} fill="#8e24aa" stroke="#fff" strokeWidth="2" />
                    <rect x={tagX} y={m.label.y - 9} width={w} height="16" rx="3" fill="#8e24aa" stroke="#fff" strokeWidth="1" />
                    <text x={tagX + w / 2} y={m.label.y + 3} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">
                      {text}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Zoom HUD (fixed to the canvas, not the world) */}
          <div className="zoom-hud">
            <button onClick={() => zoomBy(1.2)} title="Zoom in">＋</button>
            <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out">－</button>
            <button onClick={resetView} title="Reset view" className="pct">{Math.round(zoom * 100)}%</button>
          </div>
        </div>

        {/* Sidebar */}
        <div className="sidebar">
          <div className="card">
            <h3>{selected.size ? `Edit ${selected.size} cell${selected.size > 1 ? 's' : ''}` : 'Cell properties'}</h3>
            {selected.size === 0 ? (
              <div className="muted">Select a cell to edit its chemistry, voltage and capacity.</div>
            ) : (
              <>
                <div className="field">
                  <label>Chemistry (sets nominal voltage)</label>
                  <div className="chip-row">
                    {CHEMISTRIES.map((ch) => (
                      <span key={ch.id} className="chip" onClick={() => updateSelected({ voltage: ch.voltage })}>
                        {ch.name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>Common cell size (sets capacity)</label>
                  <div className="chip-row">
                    {CELL_SIZES.map((s) => (
                      <span key={s.name} className="chip" onClick={() => updateSelected({ capacity: s.capacity })}>
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>Voltage (V)</label>
                  <input type="number" step="0.1" min="0" value={selVoltage}
                    placeholder="mixed"
                    onChange={(e) => updateSelected({ voltage: Number(e.target.value) || 0 })} />
                </div>
                <div className="field">
                  <label>Capacity (Ah)</label>
                  <input type="number" step="0.1" min="0" value={selCapacity}
                    placeholder="mixed"
                    onChange={(e) => updateSelected({ capacity: Number(e.target.value) || 0 })} />
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h3>Wiring check</h3>
            <ul className="faults">
              {result.faults.length === 0 && cells.length > 0 && (
                <li className="fault ok">No wiring faults detected.</li>
              )}
              {cells.length === 0 && <li className="fault warn">No cells yet — add one to start.</li>}
              {errors.map((f, i) => <li key={`e${i}`} className="fault error">⚠ {f.message}</li>)}
              {warns.map((f, i) => <li key={`w${i}`} className="fault warn">⚠ {f.message}</li>)}
            </ul>
          </div>

          <div className="card">
            <h3>BMS / balance taps</h3>
            {bmsTaps.length === 0 ? (
              <div className="muted">{showBMS ? 'Wire up a pack to see its BMS taps.' : 'BMS overlay hidden — toggle it in the toolbar.'}</div>
            ) : (
              <>
                <div className="muted" style={{ marginBottom: 8 }}>
                  {result.series > 0 ? `${result.series}S pack → ` : ''}<strong>{bmsTaps.length}</strong> balance leads (incl. B− and B+)
                </div>
                <ul className="taps">
                  {bmsTaps.map((tap, i) => (
                    <li key={tap.net}>
                      <span className="tap-dot">{i}</span>
                      <span className="tap-name">{tapLabel(i)}</span>
                      <span className="tap-v">{tap.voltage.toFixed(2)}V</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Specs */}
      <div className="specs">
        <div className="specs-grid">
          <div className="spec v"><div className="label">Voltage</div><div className="value">{result.voltage.toFixed(1)}V</div></div>
          <div className="spec c"><div className="label">Capacity</div><div className="value">{result.capacity.toFixed(1)}Ah</div></div>
          <div className="spec e"><div className="label">Energy</div><div className="value">{energy}Wh</div></div>
          <div className="spec s"><div className="label">Configuration</div><div className="value">{result.label || '—'}</div></div>
        </div>
        <div className="specs-foot">
          <strong>{result.cellCount}</strong> cells · <strong>{result.connectionCount}</strong> wires · <strong>{result.netCount}</strong> nets
          {!result.uniform && result.cellCount > 0 && ' · mixed cells (S×P not shown)'}
        </div>
      </div>

      {/* Grid modal */}
      {gridModal && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setGridModal(false)}>
          <div className="modal">
            <h2>Create grid</h2>
            <div className="field">
              <label>Rows — series, voltage: {gridRows} × cell = {(gridRows * 3.7).toFixed(1)}V</label>
              <input type="range" min="1" max="24" value={gridRows} onChange={(e) => setGridRows(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>Columns — parallel, capacity: {gridCols} × cell = {(gridCols * 5).toFixed(0)}Ah</label>
              <input type="range" min="1" max="24" value={gridCols} onChange={(e) => setGridCols(Number(e.target.value))} />
            </div>
            <div className="muted" style={{ margin: '0.5rem 0 1rem' }}>
              Builds {gridRows * gridCols} cells, pre-wired as <strong>{gridRows}S{gridCols}P</strong>
              {' '}(≈ {(gridRows * 3.7).toFixed(1)}V / {(gridCols * 5).toFixed(0)}Ah with default cells).
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={createGrid}>Create</button>
              <button className="btn ghost" onClick={() => setGridModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Specs / BOM modal */}
      {summaryModal && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSummaryModal(false)}>
          <div className="modal" style={{ minWidth: 360 }}>
            <h2>Pack specification</h2>
            <div className="specs-grid" style={{ marginBottom: '1rem' }}>
              <div className="spec v"><div className="label">Voltage</div><div className="value">{result.voltage.toFixed(1)}V</div></div>
              <div className="spec c"><div className="label">Capacity</div><div className="value">{result.capacity.toFixed(1)}Ah</div></div>
              <div className="spec e"><div className="label">Energy</div><div className="value">{result.energy.toFixed(1)}Wh</div></div>
              <div className="spec s"><div className="label">Config</div><div className="value">{result.label || '—'}</div></div>
            </div>
            <div className="muted" style={{ marginBottom: '0.75rem' }}>
              {result.cellCount} cells · {bmsTaps.length} BMS balance leads
            </div>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: 14 }}>Bill of materials</h3>
            <table className="bom">
              <tbody>
                {bom.map((b, i) => (
                  <tr key={i}>
                    <td><strong>{b.count}×</strong></td>
                    <td>{b.voltage} V</td>
                    <td>{b.capacity} Ah</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="modal-actions" style={{ marginTop: '1.25rem' }}>
              <button className="btn" onClick={printSummary}>Print / PDF</button>
              <button className="btn ghost" onClick={() => setSummaryModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
