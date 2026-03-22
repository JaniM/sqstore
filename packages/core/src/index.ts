// ============================================================================
// Async Request Store — Implementation
// ============================================================================

import type {
  AsyncOperationDefinition,
  AsyncOperationHandle,
  AsyncOperationKeys,
  AsyncStore,
  CreateStore,
  DeepReadonly,
  ExecutionCallback,
  FactoryContext,
  InvocationChangeCallback,
  InvocationState,
  OperationDefinition,
  OperationsSchema,
  RetryConfig,
  SlotChangeCallback,
  SlotState,
  StateMutator,
  StateSchema,
  StoreConfig,
  StoreOperations,
  SyncOperationDefinition,
  SyncOperationHandle,
  Unsubscribe,
} from "./types";

export type {
  AsyncOperationDefinition,
  AsyncOperationHandle,
  AsyncOperationKeys,
  AsyncStore,
  CreateStore,
  DeepReadonly,
  ExecutionCallback,
  FactoryContext,
  InvocationChangeCallback,
  InvocationState,
  OperationDefinition,
  OperationHandle,
  OperationsSchema,
  ParamsOf,
  ResultOf,
  RetryConfig,
  SlotChangeCallback,
  SlotState,
  StateMutator,
  StateSchema,
  StoreConfig,
  StoreOperations,
  SyncOperationDefinition,
  SyncOperationHandle,
  Unsubscribe,
} from "./types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createSubscribable<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(cb: (value: T) => void): Unsubscribe {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    notify(value: T) {
      for (const cb of listeners) cb(value);
    },
    clear() {
      listeners.clear();
    },
  };
}

function resolveDelay(
  retryDelay: number | ((attempt: number) => number) | undefined,
  attempt: number,
): number {
  if (retryDelay === undefined) return 0;
  if (typeof retryDelay === "function") return retryDelay(attempt);
  return retryDelay;
}

export function createAbortError(message = "Aborted"): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// State layer
// ---------------------------------------------------------------------------

function createStateLayer<S extends StateSchema>(initialState: S) {
  const slots = new Map<string, any>();
  const slotSubs = new Map<string, ReturnType<typeof createSubscribable<SlotState<any>>>>();

  for (const key of Object.keys(initialState)) {
    slots.set(key, structuredClone(initialState[key]));
    slotSubs.set(key, createSubscribable());
  }

  function getSlotSub(key: string) {
    let sub = slotSubs.get(key);
    if (!sub) {
      sub = createSubscribable();
      slotSubs.set(key, sub);
    }
    return sub;
  }

  const mutator: StateMutator<S> = {
    get<K extends keyof S & string>(key: K): DeepReadonly<S[K]> {
      return slots.get(key) as DeepReadonly<S[K]>;
    },
    set<K extends keyof S & string>(key: K, value: S[K]): void {
      const prev = slots.get(key);
      slots.set(key, value);
      if (!Object.is(prev, value)) {
        getSlotSub(key).notify({ data: value as DeepReadonly<S[K]> });
      }
    },
    update<K extends keyof S & string>(key: K, updater: (current: S[K]) => S[K]): void {
      mutator.set(key, updater(slots.get(key) as S[K]));
    },
  };

  return {
    mutator,
    subscribe<K extends keyof S & string>(key: K, callback: SlotChangeCallback<S[K]>): Unsubscribe {
      return getSlotSub(key).subscribe(callback as any);
    },
    destroy() {
      for (const sub of slotSubs.values()) sub.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Invocation tracking
// ---------------------------------------------------------------------------

function createInvocationTracker<TResponse = unknown>() {
  const sub = createSubscribable<InvocationState<TResponse>>();

  let state: InvocationState<TResponse> = {
    status: "loading",
    error: undefined,
    data: undefined,
    resolvedFromStore: false,
    isLoading: true,
    isSuccess: false,
    isError: false,
    isCancelled: false,
    retryCount: 0,
  };

  function transition(
    patch: Partial<
      Pick<
        InvocationState<TResponse>,
        "status" | "error" | "data" | "resolvedFromStore" | "retryCount"
      >
    >,
  ) {
    const s = patch.status ?? state.status;
    state = {
      ...state,
      ...patch,
      status: s,
      data: s === "success" ? (patch.data !== undefined ? patch.data : state.data) : undefined,
      isLoading: s === "loading",
      isSuccess: s === "success",
      isError: s === "error",
      isCancelled: s === "cancelled",
    };
    sub.notify(state);
  }

  return {
    getState: () => state,
    subscribe: (cb: InvocationChangeCallback<TResponse>) => sub.subscribe(cb),
    transition,
  };
}

// ---------------------------------------------------------------------------
// Concurrency manager
// ---------------------------------------------------------------------------

interface ConcurrencyLane {
  controller: AbortController;
  promise: Promise<any>;
}

function createConcurrencyManager() {
  const lanes = new Map<string, ConcurrencyLane>();
  const activeControllers = new Set<AbortController>();

  return {
    getLane: (key: string) => lanes.get(key),
    setLane: (key: string, lane: ConcurrencyLane) => lanes.set(key, lane),
    removeLane(key: string, lane: ConcurrencyLane) {
      if (lanes.get(key) === lane) lanes.delete(key);
    },
    trackController: (c: AbortController) => activeControllers.add(c),
    untrackController: (c: AbortController) => activeControllers.delete(c),
    cancelAll() {
      for (const c of activeControllers) c.abort(createAbortError());
      activeControllers.clear();
      lanes.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// createStore implementation
// ---------------------------------------------------------------------------

export const createStore: CreateStore = <S extends StateSchema, Ops extends OperationsSchema>(
  initialState: S,
  factory: (context: FactoryContext<S>) => Ops,
  config?: StoreConfig,
): AsyncStore<S, Ops> => {
  const stateLayer = createStateLayer(initialState);
  const concurrency = createConcurrencyManager();

  // Execution subscriptions: notified when an async operation is invoked.
  const executionSubs = new Map<
    string,
    ReturnType<typeof createSubscribable<{ handle: AsyncOperationHandle<any>; params: any }>>
  >();

  function getExecutionSub(key: string) {
    let sub = executionSubs.get(key);
    if (!sub) {
      sub = createSubscribable();
      executionSubs.set(key, sub);
    }
    return sub;
  }

  // Lazy proxy: captured by factory closures, wired up before any
  // operations execute.
  const operationsProxy = {} as StoreOperations<Ops>;
  const opDefs = factory({
    operations: operationsProxy,
    get: stateLayer.mutator.get,
    set: stateLayer.mutator.set,
    update: stateLayer.mutator.update,
  });

  for (const opName of Object.keys(opDefs)) {
    const def = opDefs[opName] as OperationDefinition;
    if (def.type === "sync") {
      (operationsProxy as any)[opName] = (params?: any) =>
        executeSyncOp(def as SyncOperationDefinition<any, any>, params);
    } else {
      const asyncDef = def as AsyncOperationDefinition<any, any>;
      const fn = (params?: any) => executeAsyncOp(opName, asyncDef, params);
      fn.getLaneKey = (params?: any) => (asyncDef.key ? asyncDef.key(params) : opName);
      (operationsProxy as any)[opName] = fn;
    }
  }

  // --- Sync execution ---

  function executeSyncOp<TResult, TParams>(
    def: SyncOperationDefinition<TResult, TParams>,
    params: TParams,
  ): SyncOperationHandle<TResult> {
    return { result: def.execute(params) };
  }

  // --- Retry loop (pure — no callbacks, no state transitions except retryCount) ---

  async function executeWithRetry<TResponse, TParams>(
    def: AsyncOperationDefinition<TResponse, TParams>,
    params: TParams,
    signal: AbortSignal,
    tracker: { transition: (patch: { retryCount: number }) => void },
  ): Promise<TResponse> {
    const retryConfig: RetryConfig = { ...config?.retry, ...def.retry };
    const maxRetries = retryConfig.maxRetries ?? 0;
    let lastError!: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) {
        throw createAbortError();
      }
      try {
        return await def.execute(params, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          tracker.transition({ retryCount: attempt + 1 });
          await sleep(resolveDelay(retryConfig.retryDelay, attempt), signal);
        }
      }
    }

    throw lastError;
  }

  // --- Async execution ---

  function executeAsyncOp<TResponse, TParams>(
    opName: string,
    def: AsyncOperationDefinition<TResponse, TParams>,
    params: TParams,
  ): AsyncOperationHandle<TResponse> {
    const laneKey = def.key ? def.key(params) : opName;
    const existingLane = concurrency.getLane(laneKey);

    let handle: AsyncOperationHandle<TResponse>;

    if (existingLane) {
      switch (def.concurrency) {
        case "deduplicate":
          handle = createDeduplicatedHandle<TResponse>(existingLane);
          break;
        case "cancelPrevious":
          existingLane.controller.abort(createAbortError());
          handle = startAsyncInvocation<TResponse, TParams>(def, params, laneKey, true);
          break;
        case "enqueue":
          handle = createEnqueuedHandle<TResponse, TParams>(def, params, laneKey, existingLane);
          break;
      }
    } else {
      handle = startAsyncInvocation<TResponse, TParams>(def, params, laneKey, true);
    }

    // Notify execution subscribers synchronously before returning.
    executionSubs.get(opName)?.notify({ handle, params });

    return handle;
  }

  function createDeduplicatedHandle<TResponse>(
    lane: ConcurrencyLane,
  ): AsyncOperationHandle<TResponse> {
    const tracker = createInvocationTracker<TResponse>();
    const promise = lane.promise as Promise<TResponse>;

    // Own inert controller so cancel() doesn't abort the shared request.
    // When cancelled, transition the tracker; guard the mirror callbacks
    // so they don't overwrite a "cancelled" state.
    const ownController = new AbortController();

    ownController.signal.addEventListener(
      "abort",
      () => {
        tracker.transition({ status: "cancelled" });
      },
      { once: true },
    );

    promise.then(
      (response) => {
        if (!ownController.signal.aborted)
          tracker.transition({ status: "success", data: response });
      },
      (err) => {
        if (!ownController.signal.aborted)
          tracker.transition(
            isAbortError(err) ? { status: "cancelled" } : { status: "error", error: err },
          );
      },
    );

    return buildHandle(promise, ownController, tracker);
  }

  function createEnqueuedHandle<TResponse, TParams>(
    def: AsyncOperationDefinition<TResponse, TParams>,
    params: TParams,
    laneKey: string,
    existingLane: ConcurrencyLane,
  ): AsyncOperationHandle<TResponse> {
    const tracker = createInvocationTracker<TResponse>();
    const controller = new AbortController();
    concurrency.trackController(controller);

    const enqueuedLane: ConcurrencyLane = { controller, promise: null as any };

    const promise = existingLane.promise
      .catch(() => {})
      .then(() => {
        if (controller.signal.aborted) {
          tracker.transition({ status: "cancelled" });
          throw createAbortError();
        }
        const innerHandle = startAsyncInvocation<TResponse, TParams>(def, params, laneKey, false);

        controller.signal.addEventListener("abort", () => innerHandle.cancel(), { once: true });

        innerHandle.subscribe((s) => {
          tracker.transition({
            status: s.status,
            error: s.error,
            data: s.data,
            resolvedFromStore: s.resolvedFromStore,
            retryCount: s.retryCount,
          });
        });

        return innerHandle.promise;
      })
      .finally(() => {
        concurrency.untrackController(controller);
        concurrency.removeLane(laneKey, enqueuedLane);
      });

    enqueuedLane.promise = promise;
    concurrency.setLane(laneKey, enqueuedLane);

    return buildHandle(promise, controller, tracker);
  }

  async function waitForDeps(keys: string[], signal: AbortSignal): Promise<void> {
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(createAbortError());
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(createAbortError()),
        { once: true },
      );
    });
    abortPromise.catch(() => {}); // suppress unhandled rejection

    while (true) {
      if (signal.aborted) {
        throw createAbortError();
      }
      const activePromises: Promise<any>[] = [];
      for (const key of keys) {
        const lane = concurrency.getLane(key);
        if (lane) activePromises.push(lane.promise);
      }
      if (activePromises.length === 0) return;
      await Promise.race([Promise.allSettled(activePromises), abortPromise]);
    }
  }

  function startAsyncInvocation<TResponse, TParams>(
    def: AsyncOperationDefinition<TResponse, TParams>,
    params: TParams,
    laneKey: string,
    registerLane: boolean,
  ): AsyncOperationHandle<TResponse> {
    const tracker = createInvocationTracker<TResponse>();
    const controller = new AbortController();
    concurrency.trackController(controller);

    // Lane is set synchronously before the first await, so it's
    // visible to concurrent callers immediately.
    let lane: ConcurrencyLane | undefined;

    const promise = (async (): Promise<TResponse> => {
      try {
        // 0. Wait for dependencies
        if (def.waitFor) {
          const depKeys = def.waitFor(params);
          if (depKeys.length > 0) {
            // Register lane before awaiting so concurrent callers
            // see us (cancelPrevious can abort us, deduplicate can
            // reuse us, enqueue can chain after us).
            if (registerLane) {
              lane = { controller, promise: null as any };
              concurrency.setLane(laneKey, lane);
            }
            try {
              await waitForDeps(depKeys, controller.signal);
            } catch (err) {
              if (isAbortError(err)) {
                tracker.transition({ status: "cancelled" });
              }
              throw err;
            }
          }
        }

        // 1. Resolve check
        if (def.resolve) {
          const resolved = def.resolve(params);
          if (resolved !== undefined) {
            const response = resolved as TResponse;
            await Promise.resolve(); // yield so callers can subscribe
            if (controller.signal.aborted) {
              tracker.transition({ status: "cancelled" });
              throw createAbortError();
            }
            try {
              def.onSuccess?.(response, params);
            } finally {
              tracker.transition({ status: "success", resolvedFromStore: true, data: response });
            }
            return response;
          }
        }

        // 2. Register lane (guard: skip if already registered by waitFor)
        if (registerLane && !lane) {
          lane = { controller, promise: null as any };
          concurrency.setLane(laneKey, lane);
        }

        // 3. Execute with retry (throws on exhaustion or abort)
        let response: TResponse;
        try {
          response = await executeWithRetry(def, params, controller.signal, tracker);
        } catch (err) {
          if (isAbortError(err)) {
            tracker.transition({ status: "cancelled" });
          } else {
            try {
              def.onError?.(err as Error, params);
            } finally {
              tracker.transition({ status: "error", error: err as Error });
            }
          }
          throw err;
        }

        // 4. Success
        if (controller.signal.aborted) {
          tracker.transition({ status: "cancelled" });
          throw createAbortError();
        }
        try {
          def.onSuccess?.(response, params);
        } finally {
          tracker.transition({ status: "success", data: response });
        }
        return response;
      } finally {
        if (lane) concurrency.removeLane(laneKey, lane);
        concurrency.untrackController(controller);
      }
    })();

    // Prevent unhandled-rejection warnings for expected cancellation.
    // Errors are still delivered through the tracker/subscriber system
    // and through handle.then() for callers that await the handle.
    promise.catch(() => {});

    // Patch the lane's promise reference (IIFE runs synchronously to the
    // first await, so `lane` is already set if registerLane was true and
    // resolve didn't short-circuit).
    if (lane) lane.promise = promise;

    return buildHandle(promise, controller, tracker);
  }

  function buildHandle<T>(
    promise: Promise<T>,
    controller: AbortController,
    tracker: {
      getState: () => InvocationState<T>;
      subscribe: (cb: InvocationChangeCallback<T>) => Unsubscribe;
    },
  ): AsyncOperationHandle<T> {
    return {
      promise,
      controller,
      cancel: () => controller.abort(createAbortError()),
      getState: () => tracker.getState(),
      subscribe: (cb) => tracker.subscribe(cb),
      then: (onfulfilled, onrejected) => promise.then(onfulfilled, onrejected),
    };
  }

  // --- Store interface ---

  return {
    operations: operationsProxy,
    get: <K extends keyof S & string>(key: K) => stateLayer.mutator.get(key),
    subscribe: <K extends keyof S & string>(key: K, callback: SlotChangeCallback<S[K]>) =>
      stateLayer.subscribe(key, callback),
    onExecution<K extends AsyncOperationKeys<Ops>>(
      key: K,
      callback: ExecutionCallback<any, any>,
    ): Unsubscribe {
      return getExecutionSub(key).subscribe(({ handle, params }) => {
        callback(handle, params);
      });
    },
    destroy() {
      concurrency.cancelAll();
      stateLayer.destroy();
      for (const sub of executionSubs.values()) sub.clear();
    },
  };
};
