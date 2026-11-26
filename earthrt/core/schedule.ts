// Fetching tiles by need (ARCHITECTURE § 7): a fixed number in flight, the most wanted first, what the view stopped
// wanting dropped, failures retried with backoff. The transport is the host's (fetch on the web, assets.fetch in the
// client); this decides what to ask for and when.

export interface Transport<T> {
  /** Starts a request; resolves with the result. `signal` is aborted when the scheduler drops it. */
  get(url: string, signal: { aborted: boolean; onabort?: () => void }): Promise<T>;
}

export interface Request {
  id: string;
  url: string;
  priority: number;
}

type Slot<T> = { req: Request; signal: { aborted: boolean; onabort?: () => void }; done?: boolean; result?: T; error?: unknown };

export class Scheduler<T> {
  private readonly transport: Transport<T>;
  private readonly maxInFlight: number;
  private wanted = new Map<string, Request>();
  private inFlight = new Map<string, Slot<T>>();
  private failures = new Map<string, { n: number; until: number }>();
  private readyQueue: { id: string; result?: T; error?: unknown }[] = [];
  now: () => number = () => Date.now();

  constructor(transport: Transport<T>, maxInFlight = 12) {
    this.transport = transport;
    this.maxInFlight = maxInFlight;
  }

  /**
   * What the view wants now (replaces the last call's list). Requests under way that are no longer wanted are dropped
   * unless `keep` says otherwise (a flight's look-ahead keeps its own).
   */
  want(list: Request[], keep: (id: string) => boolean = () => false) {
    this.wanted = new Map(list.map((r) => [r.id, r]));
    for (const [id, slot] of this.inFlight) {
      if (!this.wanted.has(id) && !keep(id)) {
        slot.signal.aborted = true;
        slot.signal.onabort?.();
        this.inFlight.delete(id);
      }
    }
    this.pump();
  }

  /** Results that arrived since the last call, in the order they came. */
  take(): { id: string; result?: T; error?: unknown }[] {
    const out = this.readyQueue;
    this.readyQueue = [];
    return out;
  }

  get pending() { return this.inFlight.size; }
  isInFlight(id: string) { return this.inFlight.has(id); }

  private pump() {
    if (this.inFlight.size >= this.maxInFlight) return;
    const t = this.now();
    const queue = [...this.wanted.values()]
      .filter((r) => !this.inFlight.has(r.id) && !((this.failures.get(r.id)?.until ?? 0) > t))
      .sort((a, b) => b.priority - a.priority);
    for (const req of queue) {
      if (this.inFlight.size >= this.maxInFlight) break;
      const slot: Slot<T> = { req, signal: { aborted: false } };
      this.inFlight.set(req.id, slot);
      this.transport.get(req.url, slot.signal).then(
        (result) => this.finish(req.id, slot, { result }),
        (error) => this.finish(req.id, slot, { error }),
      );
    }
  }

  private finish(id: string, slot: Slot<T>, r: { result?: T; error?: unknown }) {
    if (slot.signal.aborted || this.inFlight.get(id) !== slot) return;
    this.inFlight.delete(id);
    if (r.error !== undefined) {
      const f = this.failures.get(id) ?? { n: 0, until: 0 };
      f.n++;
      f.until = this.now() + Math.min(60_000, 500 * 2 ** f.n);
      this.failures.set(id, f);
    } else this.failures.delete(id);
    this.readyQueue.push({ id, ...r });
    this.pump();
  }
}
