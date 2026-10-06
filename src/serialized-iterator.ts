/**
 * Prevent overlapping calls to an async iterator while allowing a parked
 * consumer to resume the same in-flight call later.
 */
export class SerializedAsyncIterator<T> {
  private pending: Promise<IteratorResult<T>> | null = null;

  constructor(
    private readonly iterator: AsyncIterator<T>,
    private readonly observer?: SerializedAsyncIteratorObserver,
  ) {}

  next(): Promise<IteratorResult<T>> {
    if (this.pending) {
      this.observer?.onNextStart?.(true);
      return this.pending;
    }

    this.observer?.onNextStart?.(false);
    const pending = Promise.resolve(this.iterator.next());
    this.pending = pending;
    void pending.then(
      (result) => this.observer?.onNextFinish?.(result.done === true),
      () => this.observer?.onNextError?.(),
    );
    return pending;
  }

  release(pending: Promise<IteratorResult<T>>): void {
    if (this.pending === pending) {
      this.pending = null;
      this.observer?.onRelease?.();
    }
  }
}

export type SerializedAsyncIteratorObserver = {
  onNextStart?: (shared: boolean) => void;
  onNextFinish?: (done: boolean) => void;
  onNextError?: () => void;
  onRelease?: () => void;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolveDeferred: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  if (!resolveDeferred) throw new Error("Failed to create pump lease");
  return { promise, resolve: resolveDeferred };
}

export class ExclusivePumpGate {
  private tail = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    const next = createDeferred();
    this.tail = next.promise;
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      next.resolve();
    };
  }
}
