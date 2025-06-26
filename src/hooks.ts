// ── Typed Event Emitter for observability hooks ─────────────────────

export interface HookEvents {
  "workflow:started": { runId: string; workflowName: string };
  "workflow:completed": {
    runId: string;
    workflowName: string;
    result: unknown;
  };
  "workflow:failed": { runId: string; workflowName: string; error: string };
  "workflow:compensated": { runId: string; workflowName: string };
  "step:started": { runId: string; workflowName: string; stepName: string };
  "step:completed": {
    runId: string;
    workflowName: string;
    stepName: string;
    result: unknown;
  };
  "step:failed": {
    runId: string;
    workflowName: string;
    stepName: string;
    error: string;
  };
}

export type HookEventName = keyof HookEvents;

type HookCallback<T> = (payload: T) => void | Promise<void>;

export class HookEmitter {
  private readonly listeners = new Map<string, HookCallback<any>[]>();

  on<K extends HookEventName>(
    event: K,
    callback: HookCallback<HookEvents[K]>,
  ): void {
    const cbs = this.listeners.get(event) ?? [];
    cbs.push(callback);
    this.listeners.set(event, cbs);
  }

  off<K extends HookEventName>(
    event: K,
    callback: HookCallback<HookEvents[K]>,
  ): void {
    const cbs = this.listeners.get(event);
    if (!cbs) return;
    const idx = cbs.indexOf(callback);
    if (idx >= 0) cbs.splice(idx, 1);
  }

  async emit<K extends HookEventName>(
    event: K,
    payload: HookEvents[K],
  ): Promise<void> {
    const cbs = this.listeners.get(event);
    if (!cbs || cbs.length === 0) return;
    for (const cb of cbs) {
      try {
        await cb(payload);
      } catch {
        // Hooks should not break the workflow  swallow errors silently.
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
