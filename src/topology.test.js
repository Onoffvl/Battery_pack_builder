import { describe, it, expect } from 'vitest';
import { analyzePack, computeBMSTaps } from './topology.js';

const cell = (id, voltage = 3.7, capacity = 5) => ({ id, voltage, capacity });
const wire = (from, fromPole, to, toPole) => ({ from, fromPole, to, toPole });

describe('analyzePack', () => {
  it('handles an empty pack', () => {
    const r = analyzePack([], []);
    expect(r.voltage).toBe(0);
    expect(r.capacity).toBe(0);
  });

  it('reports a single cell as 1S1P', () => {
    const r = analyzePack([cell(1)], []);
    expect(r.voltage).toBeCloseTo(3.7);
    expect(r.capacity).toBeCloseTo(5);
    expect(r.label).toBe('1S1P');
    expect(r.faults).toHaveLength(0);
  });

  it('adds voltage for cells in series', () => {
    const cells = [cell(1), cell(2)];
    const conns = [wire(1, '+', 2, '-')];
    const r = analyzePack(cells, conns);
    expect(r.voltage).toBeCloseTo(7.4);
    expect(r.capacity).toBeCloseTo(5);
    expect(r.label).toBe('2S1P');
  });

  it('adds capacity for cells in parallel', () => {
    const cells = [cell(1), cell(2)];
    const conns = [wire(1, '+', 2, '+'), wire(1, '-', 2, '-')];
    const r = analyzePack(cells, conns);
    expect(r.voltage).toBeCloseTo(3.7);
    expect(r.capacity).toBeCloseTo(10);
    expect(r.label).toBe('1S2P');
  });

  it('solves a 2S2P pack', () => {
    // rows in series, columns in parallel
    const cells = [cell(1), cell(2), cell(3), cell(4)];
    const conns = [
      wire(1, '+', 2, '+'), wire(1, '-', 2, '-'), // row 1 parallel
      wire(3, '+', 4, '+'), wire(3, '-', 4, '-'), // row 2 parallel
      wire(1, '+', 3, '-'),                        // series between rows
    ];
    const r = analyzePack(cells, conns);
    expect(r.voltage).toBeCloseTo(7.4);
    expect(r.capacity).toBeCloseTo(10);
    expect(r.label).toBe('2S2P');
    expect(r.energy).toBeCloseTo(4 * 3.7 * 5);
    expect(r.faults).toHaveLength(0);
  });

  it('flags a dead short', () => {
    const r = analyzePack([cell(1)], [wire(1, '+', 1, '-')]);
    expect(r.faults.some((f) => f.type === 'short')).toBe(true);
  });

  it('flags a reversed cell in a parallel group', () => {
    const cells = [cell(1), cell(2)];
    const conns = [wire(1, '+', 2, '-'), wire(1, '-', 2, '+')];
    const r = analyzePack(cells, conns);
    expect(r.faults.some((f) => f.type === 'reversed-parallel')).toBe(true);
  });

  it('warns on mismatched-voltage parallels', () => {
    const cells = [cell(1, 3.7), cell(2, 4.2)];
    const conns = [wire(1, '+', 2, '+'), wire(1, '-', 2, '-')];
    const r = analyzePack(cells, conns);
    expect(r.faults.some((f) => f.type === 'mismatch-parallel')).toBe(true);
  });

  it('warns about disconnected groups', () => {
    const cells = [cell(1), cell(2), cell(3)];
    const conns = [wire(1, '+', 2, '-')]; // cell 3 is stray
    const r = analyzePack(cells, conns);
    expect(r.faults.some((f) => f.type === 'disconnected')).toBe(true);
  });

  it('limits series capacity to the weakest link', () => {
    const cells = [cell(1, 3.7, 5), cell(2, 3.7, 2)];
    const conns = [wire(1, '+', 2, '-')];
    const r = analyzePack(cells, conns);
    expect(r.capacity).toBeCloseTo(2); // min of the series chain
  });

  it('gives a 1S pack two BMS taps (B− and B+)', () => {
    const taps = computeBMSTaps([cell(1)], []);
    expect(taps).toHaveLength(2);
    expect(taps[0].voltage).toBeCloseTo(0);
    expect(taps[1].voltage).toBeCloseTo(3.7);
  });

  it('gives a 3S pack four BMS taps at 0/3.7/7.4/11.1V', () => {
    const cells = [cell(1), cell(2), cell(3)];
    const conns = [wire(1, '+', 2, '-'), wire(2, '+', 3, '-')];
    const taps = computeBMSTaps(cells, conns);
    expect(taps).toHaveLength(4);
    expect(taps.map((t) => Number(t.voltage.toFixed(1)))).toEqual([0, 3.7, 7.4, 11.1]);
  });

  it('a 2S2P pack still has only 3 BMS taps (parallel cells share a node)', () => {
    const cells = [cell(1), cell(2), cell(3), cell(4)];
    const conns = [
      wire(1, '+', 2, '+'), wire(1, '-', 2, '-'),
      wire(3, '+', 4, '+'), wire(3, '-', 4, '-'),
      wire(1, '+', 3, '-'),
    ];
    const taps = computeBMSTaps(cells, conns);
    expect(taps).toHaveLength(3);
  });

  it('flags a half-wired cell as invalid (cell 1 − floats)', () => {
    // 6 cells: top bus joins all +, bottom bus joins only cells 2-6 (cell 1 − floats)
    const cells = [1, 2, 3, 4, 5, 6].map((id) => cell(id));
    const conns = [];
    for (let i = 2; i <= 6; i++) conns.push(wire(1, '+', i, '+')); // all + together
    for (let i = 3; i <= 6; i++) conns.push(wire(2, '-', i, '-')); // cells 2-6 − together
    const r = analyzePack(cells, conns);
    expect(r.valid).toBe(false);
    expect(r.label).toBeNull();
    expect(r.faults.length).toBeGreaterThan(0);
  });

  it('treats the pack B− output terminal as valid, not "unconnected"', () => {
    // 2S2P (cells 1-4) with cell 5 added as a 3rd series stage; cell 5 − is B−.
    const cells = [1, 2, 3, 4, 5].map((id) => cell(id));
    const conns = [
      wire(1, '+', 2, '+'), // top bus (B+)
      wire(1, '-', 3, '+'), // left series
      wire(2, '-', 4, '+'), // right series
      wire(3, '-', 4, '-'), // bottom junction
      wire(3, '-', 5, '+'), // cell 5 + onto the junction
      // cell 5 − is the open B− output
    ];
    const r = analyzePack(cells, conns);
    expect(r.voltage).toBeCloseTo(11.1);
    expect(r.capacity).toBeCloseTo(5); // lone cell 5 is the weak link
    expect(r.faults.some((f) => f.type === 'open-terminal')).toBe(false);
    expect(r.valid).toBe(true);
  });

  it('does not print an impossible S×P label', () => {
    const cells = [1, 2, 3, 4, 5, 6].map((id) => cell(id));
    const conns = [];
    for (let i = 2; i <= 6; i++) conns.push(wire(1, '+', i, '+'));
    for (let i = 3; i <= 6; i++) conns.push(wire(2, '-', i, '-'));
    const r = analyzePack(cells, conns);
    // whatever series/parallel it computes, label must account for all cells
    if (r.label) expect(r.series * r.parallel).toBe(r.cellCount);
  });

  it('a correctly wired 1S6P reports clean specs', () => {
    const cells = [1, 2, 3, 4, 5, 6].map((id) => cell(id));
    const conns = [];
    for (let i = 2; i <= 6; i++) conns.push(wire(1, '+', i, '+'));
    for (let i = 2; i <= 6; i++) conns.push(wire(1, '-', i, '-'));
    const r = analyzePack(cells, conns);
    expect(r.voltage).toBeCloseTo(3.7);
    expect(r.capacity).toBeCloseTo(30);
    expect(r.label).toBe('1S6P');
    expect(r.faults.filter((f) => f.type === 'open-terminal')).toHaveLength(0);
  });

  // Replicates exactly what createGrid() wires, to prove the grid → spec path.
  const gridDesign = (rows, cols) => {
    const grid = [];
    const cells = [];
    let id = 1;
    for (let r = 0; r < rows; r++) {
      grid[r] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(cell(id));
        grid[r][c] = id;
        id++;
      }
    }
    const conns = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 1; c < cols; c++) {
        conns.push(wire(grid[r][0], '+', grid[r][c], '+'));
        conns.push(wire(grid[r][0], '-', grid[r][c], '-'));
      }
      if (r > 0) conns.push(wire(grid[r - 1][0], '-', grid[r][0], '+'));
    }
    return { cells, conns };
  };

  it('grid 2×8 → 2S8P, 7.4V, 40Ah, valid', () => {
    const { cells, conns } = gridDesign(2, 8);
    const r = analyzePack(cells, conns);
    expect(r.label).toBe('2S8P');
    expect(r.voltage).toBeCloseTo(7.4);
    expect(r.capacity).toBeCloseTo(40);
    expect(r.valid).toBe(true);
    expect(r.faults).toHaveLength(0);
  });

  it('grid 3×4 → 3S4P, 11.1V, 20Ah, valid', () => {
    const { cells, conns } = gridDesign(3, 4);
    const r = analyzePack(cells, conns);
    expect(r.label).toBe('3S4P');
    expect(r.voltage).toBeCloseTo(11.1);
    expect(r.capacity).toBeCloseTo(20);
    expect(r.valid).toBe(true);
  });

  it('grid 1×6 → 1S6P, valid', () => {
    const { cells, conns } = gridDesign(1, 6);
    const r = analyzePack(cells, conns);
    expect(r.label).toBe('1S6P');
    expect(r.valid).toBe(true);
  });

  it('two groups joined + to + (no series path) is invalid, not a clean 2S2P', () => {
    const cells = [cell(1), cell(2), cell(3), cell(4)];
    const conns = [
      wire(1, '+', 2, '+'), wire(1, '-', 2, '-'), // group 1 parallel
      wire(3, '+', 4, '+'), wire(3, '-', 4, '-'), // group 2 parallel
      wire(1, '+', 3, '+'),                        // ties + rails, no series path
    ];
    const r = analyzePack(cells, conns);
    expect(r.valid).toBe(false);
    expect(r.label).toBeNull();
  });

  it('two cells tied + to + only (two − terminals) is invalid', () => {
    const cells = [cell(1), cell(2)];
    const conns = [wire(1, '+', 2, '+')];
    const r = analyzePack(cells, conns);
    expect(r.valid).toBe(false);
  });

  it('3S2P built as two parallel series-strings → 11.1V, 10Ah, valid', () => {
    // The bug report: two columns of 3 cells, joined only at the top/bottom rails.
    const cells = [1, 2, 3, 4, 5, 6].map((id) => cell(id));
    const conns = [
      wire(1, '+', 2, '+'), // top rail (B+)
      wire(1, '-', 3, '+'), wire(3, '-', 5, '+'), // left string
      wire(2, '-', 4, '+'), wire(4, '-', 6, '+'), // right string
      wire(5, '-', 6, '-'), // bottom rail (B−)
    ];
    const r = analyzePack(cells, conns);
    expect(r.voltage).toBeCloseTo(11.1);
    expect(r.capacity).toBeCloseTo(10);
    expect(r.label).toBe('3S2P');
    expect(r.valid).toBe(true);
    expect(r.faults).toHaveLength(0);
  });
});
