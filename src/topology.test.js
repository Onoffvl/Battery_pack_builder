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

  it('cancels two opposing cells in series to 0V', () => {
    const cells = [cell(1), cell(2)];
    const conns = [wire(1, '+', 2, '+')]; // + to + => opposing in series
    const r = analyzePack(cells, conns);
    expect(r.voltage).toBeCloseTo(0);
  });
});
