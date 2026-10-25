export interface MetricEvent {
  readonly event: "prompt" | "reply";
  readonly fromLang: string;
  readonly toLang: string;
  readonly inputChars: number;
  readonly outputChars: number;
  readonly translated: boolean;
  readonly durationMs: number;
}

/** Translation metrics of this proxy run. In-memory; `file` is where persistence (phase 7) will keep them. */
export class MetricsStore {
  private events: readonly MetricEvent[] = [];

  constructor(readonly file: string) {}

  record(event: MetricEvent): void {
    this.events = [...this.events, event];
  }

  list(): readonly MetricEvent[] {
    return this.events;
  }

  close(): void {
    this.events = [];
  }
}
