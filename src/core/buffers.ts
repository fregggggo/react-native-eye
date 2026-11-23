export class RingBuffer<T> {
  private items: T[] = [];
  private _gaps: number[] = [];

  constructor(private capacity: number) {}

  /** Returns the item that fell out the other end, so an index kept beside the buffer can drop it too. */
  push(item: T): T | undefined {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      const evicted = this.items.shift();
      this._gaps = this._gaps.map((g) => g - 1).filter((g) => g >= 0);
      return evicted;
    }
    return undefined;
  }

  all(): T[] {
    return [...this.items];
  }

  last(n: number): T[] {
    return this.items.slice(Math.max(0, this.items.length - n));
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this._gaps = [];
  }

  /**
   * Several observers report the same hole (the socket closing, the reload
   * that closed it, the reconnect after it); one hole is one gap.
   */
  markGap(): void {
    if (this._gaps[this._gaps.length - 1] === this.items.length) return;
    this._gaps.push(this.items.length);
  }

  get gaps(): number[] {
    return [...this._gaps];
  }
}
