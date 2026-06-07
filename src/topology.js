// topology.js — electrical topology engine for the battery pack designer.
//
// Pure functions, no React. Given the cells and the wires the user drew, work
// out what pack they actually built: total voltage, capacity, energy and the
// S×P shape — plus the wiring faults a hardware person actually cares about
// (dead shorts, reversed cells in a parallel group, mismatched-voltage
// parallels, stray disconnected cells).
//
// Model
// -----
// Every cell is an edge between two electrical "nets". A wire merges the two
// terminals it touches into one net (union-find). Series connections chain
// nets so voltages add; parallel connections put two cells across the same
// pair of nets so capacities add. We then collapse the net graph with
// series/parallel reduction — the same reduction you'd do by hand — until a
// single edge remains: that edge is the pack.
//
// Note: "flip" in the UI is purely cosmetic (which terminal is drawn on top).
// A cell's + terminal is always its + terminal electrically, so flipping never
// changes the netlist — it just lets you route wires without crossing them.

const EPS = 0.01; // volts; tolerance for "same voltage"

function makeUF() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x; // path compression
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

const term = (cellId, pole) => `${cellId}:${pole}`;

/**
 * Analyse the pack.
 * @param {Array<{id,voltage,capacity}>} cells
 * @param {Array<{from,fromPole,to,toPole}>} connections  poles are '+' or '-'
 */
export function analyzePack(cells, connections) {
  const faults = [];
  const empty = {
    voltage: 0, capacity: 0, energy: 0, series: 0, parallel: 0, label: null,
    uniform: true, cellCount: 0, connectionCount: connections.length,
    netCount: 0, faults, components: [],
  };
  if (!cells.length) return empty;

  // 1. Union terminals into nets.
  const uf = makeUF();
  cells.forEach((c) => {
    uf.find(term(c.id, '+'));
    uf.find(term(c.id, '-'));
  });
  connections.forEach((conn) => {
    uf.union(term(conn.from, conn.fromPole), term(conn.to, conn.toPole));
  });

  // 2. Cell edges; detect dead shorts (both terminals on one net).
  const liveCells = [];
  cells.forEach((c) => {
    const pos = uf.find(term(c.id, '+'));
    const neg = uf.find(term(c.id, '-'));
    if (pos === neg) {
      faults.push({
        type: 'short', severity: 'error', cellIds: [c.id],
        message: `Cell ${c.id} is shorted — its + and − terminals reach the same net.`,
      });
      return;
    }
    liveCells.push({ id: c.id, voltage: c.voltage, capacity: c.capacity, pos, neg });
  });

  // 3. Split into connected components (cells joined through any wiring).
  const compUF = makeUF();
  liveCells.forEach((c) => compUF.union(c.pos, c.neg));
  const comps = new Map();
  liveCells.forEach((c) => {
    const root = compUF.find(c.pos);
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root).push(c);
  });

  const components = [];
  comps.forEach((cellsIn) => components.push(reduceComponent(cellsIn, faults)));
  components.sort((a, b) => b.cellCount - a.cellCount);

  const main = components[0] || { voltage: 0, capacity: 0, series: 0, parallel: 0, cellCount: 0, uniform: true };

  if (components.length > 1) {
    const stray = components.slice(1).reduce((n, c) => n + c.cellCount, 0);
    faults.push({
      type: 'disconnected', severity: 'warn', cellIds: [],
      message: `${components.length} separate groups — ${stray} cell(s) are not wired into the main pack.`,
    });
  }

  // Energy is topology-independent: it's just the sum of every cell's Wh.
  const energy = cells.reduce((s, c) => s + c.voltage * c.capacity, 0);

  const nets = new Set();
  cells.forEach((c) => {
    nets.add(uf.find(term(c.id, '+')));
    nets.add(uf.find(term(c.id, '-')));
  });

  const label = main.uniform && main.series > 0 ? `${main.series}S${main.parallel}P` : null;

  return {
    voltage: main.voltage,
    capacity: main.capacity,
    energy,
    series: main.series,
    parallel: main.parallel,
    label,
    uniform: main.uniform,
    cellCount: cells.length,
    connectionCount: connections.length,
    netCount: nets.size,
    faults,
    components,
  };
}

/**
 * Work out where a BMS would tap the pack. A BMS monitors (and balances) every
 * series node, so an nS pack needs n+1 sense leads: the pack negative (B−),
 * each junction between series groups, and the pack positive (B+).
 *
 * Returns the taps of the MAIN pack, ordered low → high potential:
 *   [{ net, voltage, terminals: [{cellId, pole}, ...] }]
 * `voltage` is the tap's potential above B− (0V at B−). The UI uses `terminals`
 * to anchor each tap to a physical node on the canvas.
 */
export function computeBMSTaps(cells, connections) {
  if (!cells.length) return [];

  const uf = makeUF();
  cells.forEach((c) => {
    uf.find(term(c.id, '+'));
    uf.find(term(c.id, '-'));
  });
  connections.forEach((cn) => uf.union(term(cn.from, cn.fromPole), term(cn.to, cn.toPole)));

  // cell edges, dropping shorts
  const edges = [];
  cells.forEach((c) => {
    const pos = uf.find(term(c.id, '+'));
    const neg = uf.find(term(c.id, '-'));
    if (pos !== neg) edges.push({ pos, neg, v: c.voltage });
  });
  if (!edges.length) return [];

  // pick the main component (most cells)
  const compUF = makeUF();
  edges.forEach((e) => compUF.union(e.pos, e.neg));
  const compCount = new Map();
  edges.forEach((e) => {
    const r = compUF.find(e.pos);
    compCount.set(r, (compCount.get(r) || 0) + 1);
  });
  let mainRoot = null;
  let best = -1;
  compCount.forEach((n, r) => { if (n > best) { best = n; mainRoot = r; } });

  // potentials over the main component
  const adj = new Map();
  const touch = (n) => { if (!adj.has(n)) adj.set(n, []); };
  edges.forEach((e) => {
    if (compUF.find(e.pos) !== mainRoot) return;
    touch(e.pos);
    touch(e.neg);
    adj.get(e.neg).push({ to: e.pos, dv: e.v });
    adj.get(e.pos).push({ to: e.neg, dv: -e.v });
  });
  const pot = new Map();
  const start = adj.keys().next().value;
  if (start !== undefined) {
    pot.set(start, 0);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      for (const { to, dv } of adj.get(n)) {
        if (!pot.has(to)) {
          pot.set(to, pot.get(n) + dv);
          stack.push(to);
        }
      }
    }
  }
  const minP = pot.size ? Math.min(...pot.values()) : 0;

  // group the physical terminals by net (main component only)
  const termsByNet = new Map();
  cells.forEach((c) => {
    ['+', '-'].forEach((pole) => {
      const net = uf.find(term(c.id, pole));
      if (compUF.find(net) !== mainRoot) return;
      if (!termsByNet.has(net)) termsByNet.set(net, []);
      termsByNet.get(net).push({ cellId: c.id, pole });
    });
  });

  const taps = [];
  termsByNet.forEach((terminals, net) => {
    taps.push({ net, voltage: (pot.get(net) ?? 0) - minP, terminals });
  });
  taps.sort((a, b) => a.voltage - b.voltage);
  return taps;
}

/**
 * Group terminals into electrical nets. Each net with two or more terminals is
 * one physical nickel strip (a parallel bus, or a shared series junction). The
 * UI draws one strip per net, so the picture matches what you'd actually weld.
 * Returns [{ terminals: [{cellId, pole}] }] for nets of size ≥ 2.
 */
export function computeNets(cells, connections) {
  const uf = makeUF();
  cells.forEach((c) => {
    uf.find(term(c.id, '+'));
    uf.find(term(c.id, '-'));
  });
  connections.forEach((cn) => uf.union(term(cn.from, cn.fromPole), term(cn.to, cn.toPole)));

  const groups = new Map();
  cells.forEach((c) => {
    ['+', '-'].forEach((pole) => {
      const root = uf.find(term(c.id, pole));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push({ cellId: c.id, pole });
    });
  });
  return [...groups.values()].filter((g) => g.length >= 2).map((terminals) => ({ terminals }));
}

// Collapse one connected component down to a single equivalent edge.
function reduceComponent(cellsIn, faults) {
  // edge.v = potential(to) − potential(from); we keep edges oriented − → +.
  let edges = cellsIn.map((c) => ({
    from: c.neg, to: c.pos, v: c.voltage, cap: c.capacity,
    cellIds: [c.id], series: 1, parallel: 1,
  }));

  const first = cellsIn[0];
  const uniform = cellsIn.every(
    (c) => Math.abs(c.voltage - first.voltage) < EPS && Math.abs(c.capacity - first.capacity) < EPS
  );

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10000) {
    changed = false;

    // --- Parallel: two edges across the same pair of nets ---
    for (let i = 0; i < edges.length && !changed; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const a = edges[i];
        const b = edges[j];
        const same = a.from === b.from && a.to === b.to;
        const opp = a.from === b.to && a.to === b.from;
        if (!same && !opp) continue;

        if (opp) {
          faults.push({
            type: 'reversed-parallel', severity: 'error',
            cellIds: [...a.cellIds, ...b.cellIds],
            message: `Cell(s) ${b.cellIds.join(', ')} are reversed against ${a.cellIds.join(', ')} in a parallel group — they'll dump current into each other.`,
          });
        } else if (Math.abs(a.v - b.v) > EPS) {
          faults.push({
            type: 'mismatch-parallel', severity: 'warn',
            cellIds: [...a.cellIds, ...b.cellIds],
            message: `Parallel cells at different voltages (${a.v.toFixed(2)}V vs ${b.v.toFixed(2)}V) — heavy balancing current at the joint.`,
          });
        }

        edges[i] = {
          from: a.from, to: a.to, v: a.v, cap: a.cap + b.cap,
          cellIds: [...a.cellIds, ...b.cellIds],
          series: a.series, parallel: a.parallel + b.parallel,
        };
        edges.splice(j, 1);
        changed = true;
        break;
      }
    }
    if (changed) continue;

    // --- Series: a net touched by exactly two edges collapses through ---
    const deg = new Map();
    edges.forEach((e) => {
      deg.set(e.from, (deg.get(e.from) || 0) + 1);
      deg.set(e.to, (deg.get(e.to) || 0) + 1);
    });
    for (const [net, d] of deg) {
      if (d !== 2) continue;
      const inc = [];
      edges.forEach((e, idx) => {
        if (e.from === net || e.to === net) inc.push(idx);
      });
      if (inc.length !== 2) continue; // a self-loop would land here; skip it
      const e1 = edges[inc[0]];
      const e2 = edges[inc[1]];
      // Re-orient both to flow x → net → y, then merge into x → y.
      const x = e1.from === net ? e1.to : e1.from;
      const v1 = e1.from === net ? -e1.v : e1.v; // delta x → net
      const y = e2.from === net ? e2.to : e2.from;
      const v2 = e2.from === net ? e2.v : -e2.v; // delta net → y
      const merged = {
        from: x, to: y, v: v1 + v2,
        cap: Math.min(e1.cap, e2.cap),
        cellIds: [...e1.cellIds, ...e2.cellIds],
        series: e1.series + e2.series,
        parallel: Math.max(e1.parallel, e2.parallel),
      };
      edges = edges.filter((_, idx) => idx !== inc[0] && idx !== inc[1]);
      edges.push(merged);
      changed = true;
      break;
    }
  }

  if (edges.length === 1) {
    return {
      voltage: Math.abs(edges[0].v),
      capacity: edges[0].cap,
      series: edges[0].series,
      parallel: edges[0].parallel,
      cellCount: cellsIn.length,
      uniform,
    };
  }

  // Irreducible: a bridge or loop, not a clean series/parallel pack.
  faults.push({
    type: 'non-sp', severity: 'warn', cellIds: cellsIn.map((c) => c.id),
    message: "This wiring isn't a simple series/parallel pack (bridge or loop) — voltage and capacity are estimates.",
  });
  const pot = potentials(edges);
  const vals = [...pot.values()];
  const voltage = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const totalWh = cellsIn.reduce((s, c) => s + c.voltage * c.capacity, 0);
  return {
    voltage,
    capacity: voltage > EPS ? totalWh / voltage : 0,
    series: 0, parallel: 0,
    cellCount: cellsIn.length,
    uniform,
  };
}

// Assign a potential to every net by walking the edges (best-effort for
// irreducible graphs; ignores loop inconsistencies).
function potentials(edges) {
  const pot = new Map();
  const adj = new Map();
  const touch = (n) => { if (!adj.has(n)) adj.set(n, []); };
  edges.forEach((e) => {
    touch(e.from);
    touch(e.to);
    adj.get(e.from).push({ to: e.to, v: e.v });
    adj.get(e.to).push({ to: e.from, v: -e.v });
  });
  for (const start of adj.keys()) {
    if (pot.has(start)) continue;
    pot.set(start, 0);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      for (const { to, v } of adj.get(n)) {
        if (!pot.has(to)) {
          pot.set(to, pot.get(n) + v);
          stack.push(to);
        }
      }
    }
  }
  return pot;
}
