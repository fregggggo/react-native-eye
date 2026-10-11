export class RingBuffer<T> {
  private items: T[] = [];
  private _gaps: number[] = [];

  constructor(private capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this._gaps = this._gaps.map((g) => g - 1).filter((g) => g >= 0);
    }
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

  markGap(): void {
    this._gaps.push(this.items.length);
  }

  get gaps(): number[] {
    return [...this._gaps];
  }
}
