export class SingleFlight {
  private running = false;

  async run<T>(
    work: () => Promise<T>
  ): Promise<{ started: true; value: T } | { started: false; reason: 'overlap' }> {
    if (this.running) {
      return { started: false, reason: 'overlap' };
    }

    this.running = true;
    try {
      return { started: true, value: await work() };
    } finally {
      this.running = false;
    }
  }
}
