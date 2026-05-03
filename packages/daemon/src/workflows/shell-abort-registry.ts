export interface WorkflowShellAbortHandle {
  signal: AbortSignal;
  dispose: () => void;
}

export class WorkflowShellAbortRegistry {
  private readonly controllers = new Map<string, Map<string, AbortController>>();

  create(runId: string, scope: string): WorkflowShellAbortHandle {
    const controller = new AbortController();
    let runControllers = this.controllers.get(runId);
    if (!runControllers) {
      runControllers = new Map();
      this.controllers.set(runId, runControllers);
    }
    runControllers.set(scope, controller);

    return {
      signal: controller.signal,
      dispose: () => this.dispose(runId, scope, controller),
    };
  }

  cancelRun(runId: string): void {
    const runControllers = this.controllers.get(runId);
    if (!runControllers) return;
    for (const controller of runControllers.values()) {
      controller.abort();
    }
    this.controllers.delete(runId);
  }

  private dispose(runId: string, scope: string, controller: AbortController): void {
    const runControllers = this.controllers.get(runId);
    if (!runControllers || runControllers.get(scope) !== controller) return;
    runControllers.delete(scope);
    if (runControllers.size === 0) {
      this.controllers.delete(runId);
    }
  }
}
