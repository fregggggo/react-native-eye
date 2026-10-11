import { describe, it, expect } from "vitest";
import { RingBuffer } from "../../src/core/buffers.js";

describe("RingBuffer", () => {
  it("keeps only the last `capacity` items", () => {
    const b = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => b.push(n));
    expect(b.all()).toEqual([3, 4, 5]);
    expect(b.size()).toBe(3);
  });

  it("last(n) returns most recent n oldest-first", () => {
    const b = new RingBuffer<number>(10);
    [1, 2, 3, 4].forEach((n) => b.push(n));
    expect(b.last(2)).toEqual([3, 4]);
    expect(b.last(99)).toEqual([1, 2, 3, 4]);
  });

  it("clear empties the buffer", () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.clear();
    expect(b.all()).toEqual([]);
  });

  it("markGap records the current size as a gap position", () => {
    const b = new RingBuffer<number>(10);
    b.push(1);
    b.markGap();
    b.push(2);
    expect(b.gaps).toContain(1);
  });
});
