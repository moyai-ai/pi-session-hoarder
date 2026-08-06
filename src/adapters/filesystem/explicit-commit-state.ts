/** Shared explicit-commit lifecycle for filesystem Unit of Work adapters. */
export class ExplicitCommitState {
  private committed = false;
  private disposed = false;

  assertOpen(): void {
    if (this.disposed) throw new Error("Unit of Work is already disposed.");
    if (this.committed) throw new Error("Unit of Work is already committed.");
  }

  markCommitted(): void {
    this.committed = true;
  }

  async rollback(action: () => void | Promise<void>): Promise<void> {
    if (this.disposed) return;
    await action();
  }

  async dispose(rollback: () => Promise<void>): Promise<void> {
    if (this.disposed) return;
    if (!this.committed) await rollback();
    this.disposed = true;
  }
}
