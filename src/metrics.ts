export interface Metrics {
  increment(name: string, amount?: number): void;
}

export class NoopMetrics implements Metrics {
  increment(_name: string, _amount = 1): void {}
}

export class MetricsRegistry implements Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
