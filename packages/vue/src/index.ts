import type {
  AsyncOperationHandle,
  AsyncOperationKeys,
  AsyncStore,
  DeepReadonly,
  InvocationState,
  OperationsSchema,
  ParamsOf,
  ResultOf,
  StateSchema,
  SyncOperationHandle,
  Unsubscribe,
} from "@sqstore/core";
import { onScopeDispose, readonly, type ShallowRef, shallowRef } from "vue";

// Re-export core types commonly needed by consumers
export type {
  AsyncOperationKeys,
  AsyncStore,
  ExecutionCallback,
  InvocationState,
  OperationsSchema,
  ParamsOf,
  ResultOf,
  StateSchema,
} from "@sqstore/core";
export { createStore } from "@sqstore/core";

// ---------------------------------------------------------------------------
// useSlot
// ---------------------------------------------------------------------------

/**
 * Returns a reactive readonly ref that tracks a store state slot.
 *
 * Uses `shallowRef` since the store manages immutability via `DeepReadonly`.
 * Unsubscribes automatically on scope disposal.
 *
 * An optional `selector` derives a value from the slot. Updates only trigger
 * when the selected value changes (by `Object.is`, courtesy of `shallowRef`).
 */

// Overload: no selector — returns full slot value
export function useSlot<
  S extends StateSchema,
  Ops extends OperationsSchema,
  K extends keyof S & string,
>(store: AsyncStore<S, Ops>, key: K): Readonly<ShallowRef<DeepReadonly<S[K]>>>;

// Overload: with selector — returns derived value
export function useSlot<
  S extends StateSchema,
  Ops extends OperationsSchema,
  K extends keyof S & string,
  TSelected,
>(
  store: AsyncStore<S, Ops>,
  key: K,
  selector: (value: DeepReadonly<S[K]>) => TSelected,
): Readonly<ShallowRef<TSelected>>;

// Implementation
export function useSlot<
  S extends StateSchema,
  Ops extends OperationsSchema,
  K extends keyof S & string,
  TSelected = DeepReadonly<S[K]>,
>(
  store: AsyncStore<S, Ops>,
  key: K,
  selector?: (value: DeepReadonly<S[K]>) => TSelected,
): Readonly<ShallowRef<TSelected>> {
  const select = selector ?? ((v: DeepReadonly<S[K]>) => v as unknown as TSelected);

  const value = shallowRef(select(store.get(key))) as ShallowRef<TSelected>;

  const unsub = store.subscribe(key, (state) => {
    value.value = select(state.data);
  });

  // Re-read after subscribing to close the race window between get() and subscribe().
  // If state changed in between, the subscription may not have fired for that update.
  const current = select(store.get(key));
  if (value.value !== current) {
    value.value = current;
  }

  onScopeDispose(unsub);

  return readonly(value) as Readonly<ShallowRef<TSelected>>;
}

// ---------------------------------------------------------------------------
// useOperation — types
// ---------------------------------------------------------------------------

/**
 * Options for `useOperation`.
 *
 * - `immediate: true` — auto-executes on mount (with `params` if provided,
 *   otherwise with `undefined`).
 * - `params` — provides default params for `execute()` and enables passive
 *   lane-aware tracking via `store.onExecution()`. When provided, the
 *   composable observes all executions on the matching concurrency lane,
 *   not just those it initiates.
 */
export interface UseOperationOptions<TParams> {
  immediate?: boolean;
  params?: TParams;
  cancelOnUnmount?: boolean;
}

/**
 * Return type of `useOperation`.
 *
 * For async operations, all lifecycle refs are active.
 * For sync operations, lifecycle refs remain at initial values (null/false).
 */
export interface UseOperationReturn<TResult, TParams> {
  /** Call to invoke the operation. For async ops, replaces any previously tracked invocation. */
  execute: (...args: TParams extends void ? [] : [params: TParams]) => void;

  /** The result of the operation (async: resolved response, sync: return value). */
  data: Readonly<ShallowRef<TResult | undefined>>;

  // --- Async-only lifecycle (inert for sync operations) ---

  /** Full invocation state (null before first execute, always null for sync ops). */
  state: Readonly<ShallowRef<InvocationState<TResult> | null>>;
  /** Lifecycle flags (always false for sync ops). */
  isLoading: Readonly<ShallowRef<boolean>>;
  isSuccess: Readonly<ShallowRef<boolean>>;
  isError: Readonly<ShallowRef<boolean>>;
  isCancelled: Readonly<ShallowRef<boolean>>;
  error: Readonly<ShallowRef<Error | undefined>>;
}

// ---------------------------------------------------------------------------
// useOperation — implementation
// ---------------------------------------------------------------------------

/**
 * Returns reactive refs that track an operation's lifecycle.
 *
 * - For **async** operations: `execute()` invokes the operation, subscribes
 *   to the handle's lifecycle, and updates all refs. Each call replaces and
 *   cancels the previous tracked invocation.
 * - For **sync** operations: `execute()` invokes the operation and sets
 *   `data`. Lifecycle refs stay at their initial values.
 *
 * When `params` is provided, the composable passively tracks all executions
 * on the matching concurrency lane via `store.onExecution()`. Scope disposal
 * unsubscribes but does **not** cancel the tracked handle.
 *
 * Without `params`, scope disposal cancels the current invocation only when
 * `cancelOnUnmount: true` is set.
 */

// Overload: with params → execute() takes no args
export function useOperation<
  S extends StateSchema,
  Ops extends OperationsSchema,
  K extends keyof Ops & string,
>(
  store: AsyncStore<S, Ops>,
  key: K,
  options: UseOperationOptions<ParamsOf<Ops[K]>> & { params: ParamsOf<Ops[K]> },
): UseOperationReturn<ResultOf<Ops[K]>, void>;

// Overload: without params → execute() takes params
export function useOperation<
  S extends StateSchema,
  Ops extends OperationsSchema,
  K extends keyof Ops & string,
>(
  store: AsyncStore<S, Ops>,
  key: K,
  options?: UseOperationOptions<ParamsOf<Ops[K]>>,
): UseOperationReturn<ResultOf<Ops[K]>, ParamsOf<Ops[K]>>;

// Implementation
export function useOperation<
  S extends StateSchema,
  Ops extends OperationsSchema,
  K extends keyof Ops & string,
>(
  store: AsyncStore<S, Ops>,
  key: K,
  options?: UseOperationOptions<ParamsOf<Ops[K]>>,
): UseOperationReturn<ResultOf<Ops[K]>, any> {
  type TResult = ResultOf<Ops[K]>;
  type TParams = ParamsOf<Ops[K]>;

  const data = shallowRef<TResult | undefined>(undefined) as ShallowRef<TResult | undefined>;
  const state = shallowRef<InvocationState<TResult> | null>(
    null,
  ) as ShallowRef<InvocationState<TResult> | null>;
  const isLoading = shallowRef(false);
  const isSuccess = shallowRef(false);
  const isError = shallowRef(false);
  const isCancelled = shallowRef(false);
  const error = shallowRef<Error | undefined>(undefined) as ShallowRef<Error | undefined>;

  // Current async invocation tracking
  let currentUnsub: Unsubscribe | undefined;
  let currentHandle: AsyncOperationHandle<TResult> | undefined;

  function updateFromState(s: InvocationState<TResult>) {
    state.value = s;
    isLoading.value = s.isLoading;
    isSuccess.value = s.isSuccess;
    isError.value = s.isError;
    isCancelled.value = s.isCancelled;
    error.value = s.error;
    if (s.data !== undefined) {
      data.value = s.data;
    }
  }

  const hasParams = options != null && "params" in options;

  if (hasParams) {
    // -----------------------------------------------------------------------
    // Params path: passive lane-aware tracking via onExecution
    // -----------------------------------------------------------------------
    const defaultParams = options!.params as TParams;
    const op = store.operations[key] as any;

    // For async ops, compute the target lane key
    const targetLaneKey: string | undefined =
      typeof op.getLaneKey === "function" ? op.getLaneKey(defaultParams) : undefined;

    // Unsubscribe from current handle without cancelling (passive observer)
    function unsubCurrent() {
      if (currentUnsub) {
        currentUnsub();
        currentUnsub = undefined;
      }
      currentHandle = undefined;
    }

    // Register onExecution listener for async operations
    let unsubExecution: Unsubscribe | undefined;
    if (targetLaneKey !== undefined) {
      unsubExecution = store.onExecution(
        key as unknown as AsyncOperationKeys<Ops>,
        ((handle: AsyncOperationHandle<TResult>, params: TParams) => {
          const incomingLaneKey = op.getLaneKey(params);
          if (incomingLaneKey !== targetLaneKey) return;

          // Swap subscription to new handle (no cancel)
          unsubCurrent();
          currentHandle = handle;
          currentUnsub = handle.subscribe(updateFromState);
          updateFromState(handle.getState());
          handle.promise.catch(() => {});
        }) as any,
      );
    }

    const execute = (() => {
      const handle = op(defaultParams);

      if ("subscribe" in handle && "promise" in handle) {
        // The onExecution callback has already fired synchronously and
        // subscribed, so we don't need to do anything else here.
      } else {
        // Sync operation
        const syncHandle = handle as SyncOperationHandle<TResult>;
        data.value = syncHandle.result;
      }
    }) as UseOperationReturn<TResult, void>["execute"];

    onScopeDispose(() => {
      unsubCurrent();
      unsubExecution?.();
    });

    if (options!.immediate) {
      execute();
    }

    return {
      execute,
      data: readonly(data) as Readonly<ShallowRef<TResult | undefined>>,
      state: readonly(state) as Readonly<ShallowRef<InvocationState<TResult> | null>>,
      isLoading: readonly(isLoading) as Readonly<ShallowRef<boolean>>,
      isSuccess: readonly(isSuccess) as Readonly<ShallowRef<boolean>>,
      isError: readonly(isError) as Readonly<ShallowRef<boolean>>,
      isCancelled: readonly(isCancelled) as Readonly<ShallowRef<boolean>>,
      error: readonly(error) as Readonly<ShallowRef<Error | undefined>>,
    };
  }

  // -------------------------------------------------------------------------
  // No-params path: original behavior (cancel on re-execute & dispose)
  // -------------------------------------------------------------------------

  // Unsubscribe before cancelling so the old handle's cancellation event
  // doesn't flash through the UI refs before the new handle's loading state.
  function cleanupCurrent() {
    if (currentUnsub) {
      currentUnsub();
      currentUnsub = undefined;
    }
    if (currentHandle) {
      currentHandle.cancel();
      currentHandle = undefined;
    }
  }

  const execute = ((...args: any[]) => {
    const params = args[0] as TParams;
    const op = store.operations[key] as any;
    const handle = op(params);

    // Check if handle is an async handle (has `subscribe` and `promise`)
    if ("subscribe" in handle && "promise" in handle) {
      // Async operation
      cleanupCurrent();

      const asyncHandle = handle as AsyncOperationHandle<TResult>;
      currentHandle = asyncHandle;

      // Subscribe to lifecycle changes
      currentUnsub = asyncHandle.subscribe(updateFromState);

      // Set initial state from handle
      updateFromState(asyncHandle.getState());

      // Suppress unhandled rejection for the promise
      asyncHandle.promise.catch(() => {});
    } else {
      // Sync operation
      const syncHandle = handle as SyncOperationHandle<TResult>;
      data.value = syncHandle.result;
    }
  }) as UseOperationReturn<TResult, TParams>["execute"];

  onScopeDispose(() => {
    if (currentUnsub) {
      currentUnsub();
      currentUnsub = undefined;
    }
    if (currentHandle) {
      if (options?.cancelOnUnmount) {
        currentHandle.cancel();
      }
      currentHandle = undefined;
    }
  });

  // Handle immediate invocation
  if (options?.immediate) {
    (execute as (...args: any[]) => void)();
  }

  return {
    execute: execute as any,
    data: readonly(data) as Readonly<ShallowRef<TResult | undefined>>,
    state: readonly(state) as Readonly<ShallowRef<InvocationState<TResult> | null>>,
    isLoading: readonly(isLoading) as Readonly<ShallowRef<boolean>>,
    isSuccess: readonly(isSuccess) as Readonly<ShallowRef<boolean>>,
    isError: readonly(isError) as Readonly<ShallowRef<boolean>>,
    isCancelled: readonly(isCancelled) as Readonly<ShallowRef<boolean>>,
    error: readonly(error) as Readonly<ShallowRef<Error | undefined>>,
  };
}
