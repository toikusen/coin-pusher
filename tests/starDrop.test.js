import { describe, expect, it } from 'vitest';
import {
  coreReward, fillMeter, GOLD_RAIN_PEARLS, METER_SIZE, roundOver, slotAt, SLOT_COUNT, SLOTS,
} from '../src/game/starDrop.js';

describe('slots', () => {
  it('cuts the board into five equal slots, edge to edge', () => {
    expect(slotAt(-3.45, 3.45)).toBe(0);
    expect(slotAt(0, 3.45)).toBe(2);
    expect(slotAt(3.45, 3.45)).toBe(SLOT_COUNT - 1);
    expect(slotAt(-99, 3.45)).toBe(0);
  });

  it('feeds the meter outside, pearls inside, and a core in the centre', () => {
    expect(SLOTS.map(({ meter }) => Boolean(meter))).toEqual([true, false, false, false, true]);
    expect(SLOTS.map(({ pearls }) => Boolean(pearls))).toEqual([false, true, false, true, false]);
    expect(SLOTS[2].core).toBe(1);
    expect(SLOTS[1].side).toBe(-1);
    expect(SLOTS[3].side).toBe(1);
  });
});

describe('the rain meter', () => {
  it('fills, and goes off when full, carrying what is left over', () => {
    expect(fillMeter(1, 1)).toEqual({ meter: 2, rains: 0 });
    expect(fillMeter(METER_SIZE - 1, 1)).toEqual({ meter: 0, rains: 1 });
    expect(fillMeter(METER_SIZE - 1, 2)).toEqual({ meter: 1, rains: 1 });
  });
});

describe('star cores', () => {
  it('pays more for a higher core, a gold one being a rain', () => {
    expect(coreReward(1)).toEqual({ meter: 0, pearls: 0 });
    expect(coreReward(2).meter).toBeGreaterThan(0);
    expect(coreReward(3).pearls).toBe(GOLD_RAIN_PEARLS);
  });
});

describe('roundOver', () => {
  const done = { balls: 0, inFlight: 0, pouring: false, sinceExit: 3, sinceLast: 3 };

  it('waits for the last ball and the last pearl', () => {
    expect(roundOver({ ...done, balls: 1 })).toBe(false);
    expect(roundOver({ ...done, inFlight: 1 })).toBe(false);
    expect(roundOver({ ...done, pouring: true })).toBe(false);
  });

  it('ends once the pile goes quiet, or after a ceiling', () => {
    expect(roundOver(done)).toBe(true);
    expect(roundOver({ ...done, sinceExit: 1 })).toBe(false);
    expect(roundOver({ ...done, sinceExit: 1, sinceLast: 15 })).toBe(true);
  });
});
