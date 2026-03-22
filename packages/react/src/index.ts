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
import { type DependencyList, useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

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
export { createAbortError, createStore, isAbortError } from "@sqstore/core";

// ---------------------------------------------------------------------------
// useSlot
// ---------------------------------------------------------------------------

/**
 * Returns the current value of a store state slot.
 *
 * Uses `useSyncExternalStore` for tear-free concurrent-safe reads.
 * Unsubscribes automatically on unmount.
 *
 * An optional `selector` derives a value from the slot. Re-renders only
 * trigger when the selected value changes (by `Object.is`, courtesy of
 * `useSyncExternalStore`).
 */

// Overload: no selector — returns full slot value
export function useSlot<
  S extends StateSchema,
  Ops extends OperationsSchema,
  K extends keyof S & string,
>(store: AsyncStore<S, Ops>, key: K): DeepReadonly<S[K]>;

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
): TSelected;

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
): TSelected {
  // Cache the selector in a ref so getSnapshot is stable across renders
  // while always using the latest selector function.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return store.subscribe(key, onStoreChange);
    },
    [store, key],
  );

  const getSnapshot = useCallback(() => {
    const raw = store.get(key);
    return selectorRef.current ? selectorRef.current(raw) : (raw as unknown as TSelected);
  }, [store, key]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
 *   hook observes all executions on the matching concurrency lane,
 *   not just those it initiates.
 */
export interface UseOperationOptions<TParams> {
  immediate?: boolean;
  params?: TParams;
  cancelOnUnmount?: boolean;
}

interface OperationSnapshot<TResult> {
  data: TResult | undefined;
  state: InvocationState<TResult> | null;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isCancelled: boolean;
  error: Error | undefined;
}

/**
 * Return type of `useOperation`.
 *
 * For async operations, all lifecycle fields are active.
 * For sync operations, lifecycle fields remain at initial values (null/false).
 */
export interface UseOperationReturn<TResult, TParams> {
  /** Call to invoke the operation. For async ops, replaces any previously tracked invocation. */
  execute: (...args: TParams extends void ? [] : [params: TParams]) => void;

  /** The result of the operation (async: resolved response, sync: return value). */
  data: TResult | undefined;

  // --- Async-only lifecycle (inert for sync operations) ---

  /** Full invocation state (null before first execute, always null for sync ops). */
  state: InvocationState<TResult> | null;
  /** Lifecycle flags (always false for sync ops). */
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isCancelled: boolean;
  error: Error | undefined;
}

// ---------------------------------------------------------------------------
// useOperation — reducer
// ---------------------------------------------------------------------------

const initialSnapshot: OperationSnapshot<any> = {
  data: undefined,
  state: null,
  isLoading: false,
  isSuccess: false,
  isError: false,
  isCancelled: false,
  error: undefined,
};

type ReducerAction<TResult> =
  | { type: "invocationState"; payload: InvocationState<TResult> }
  | { type: "syncResult"; payload: TResult };

function snapshotReducer<TResult>(
  prev: OperationSnapshot<TResult>,
  action: ReducerAction<TResult>,
): OperationSnapshot<TResult> {
  if (action.type === "syncResult") {
    return { ...prev, data: action.payload };
  }

  const s = action.payload;
  return {
    state: s,
    isLoading: s.isLoading,
    isSuccess: s.isSuccess,
    isError: s.isError,
    isCancelled: s.isCancelled,
    error: s.error,
    data: s.data !== undefined ? s.data : prev.data,
  };
}

// ---------------------------------------------------------------------------
// useOperation — implementation
// ---------------------------------------------------------------------------

/**
 * Returns reactive state that tracks an operation's lifecycle.
 *
 * - For **async** operations: `execute()` invokes the operation, subscribes
 *   to the handle's lifecycle, and updates state. Each call replaces and
 *   cancels the previous tracked invocation.
 * - For **sync** operations: `execute()` invokes the operation and sets
 *   `data`. Lifecycle fields stay at their initial values.
 *
 * When `params` is provided, the hook passively tracks all executions
 * on the matching concurrency lane via `store.onExecution()`. Unmount
 * unsubscribes but does **not** cancel the tracked handle.
 *
 * Without `params`, unmount cancels the current invocation only when
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

  const [snapshot, dispatch] = useReducer(
    snapshotReducer<TResult>,
    initialSnapshot as OperationSnapshot<TResult>,
  );

  const hasParams = options != null && "params" in options;

  // Mutable refs for tracking current handle/unsub across renders
  const currentUnsubRef = useRef<Unsubscribe | undefined>(undefined);
  const currentHandleRef = useRef<AsyncOperationHandle<TResult> | undefined>(undefined);
  const hasParamsRef = useRef(hasParams);
  hasParamsRef.current = hasParams;
  const cancelOnUnmountRef = useRef(!!options?.cancelOnUnmount);
  cancelOnUnmountRef.current = !!options?.cancelOnUnmount;

  function updateFromState(s: InvocationState<TResult>) {
    dispatch({ type: "invocationState", payload: s });
  }

  // --- Params path: passive lane-aware tracking via onExecution ---

  useEffect(() => {
    if (!hasParams) return;

    const defaultParams = options!.params as TParams;
    const op = store.operations[key] as any;

    const targetLaneKey: string | undefined =
      typeof op.getLaneKey === "function" ? op.getLaneKey(defaultParams) : undefined;

    if (targetLaneKey === undefined) return;

    const unsubExecution = store.onExecution(
      key as unknown as AsyncOperationKeys<Ops>,
      ((handle: AsyncOperationHandle<TResult>, params: TParams) => {
        const incomingLaneKey = op.getLaneKey(params);
        if (incomingLaneKey !== targetLaneKey) return;

        // Swap subscription to new handle (no cancel — passive observer)
        if (currentUnsubRef.current) {
          currentUnsubRef.current();
        }
        currentHandleRef.current = handle;
        currentUnsubRef.current = handle.subscribe(updateFromState);
        updateFromState(handle.getState());
        handle.promise.catch(() => {});
      }) as any,
    );

    return () => {
      // Unsubscribe from handle without cancelling (passive)
      if (currentUnsubRef.current) {
        currentUnsubRef.current();
        currentUnsubRef.current = undefined;
      }
      currentHandleRef.current = undefined;
      unsubExecution();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, hasParams, hasParams ? JSON.stringify(options!.params) : ""]);

  // --- No-params path: cancel on unmount ---

  useEffect(() => {
    if (hasParams) return;

    return () => {
      if (currentUnsubRef.current) {
        currentUnsubRef.current();
        currentUnsubRef.current = undefined;
      }
      if (currentHandleRef.current) {
        if (cancelOnUnmountRef.current) {
          currentHandleRef.current.cancel();
        }
        currentHandleRef.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, hasParams]);

  // --- Execute ---

  const execute = useCallback(
    (...args: any[]) => {
      const params = hasParamsRef.current ? (options!.params as TParams) : (args[0] as TParams);
      const op = store.operations[key] as any;
      const handle = op(params);

      if ("subscribe" in handle && "promise" in handle) {
        // Async operation — only do cleanup/cancel if NOT in params mode
        // (params mode handles subscription swap via onExecution)
        if (!hasParamsRef.current) {
          // Unsub first to avoid cancelled state flashing
          if (currentUnsubRef.current) {
            currentUnsubRef.current();
          }
          if (currentHandleRef.current) {
            currentHandleRef.current.cancel();
          }

          const asyncHandle = handle as AsyncOperationHandle<TResult>;
          currentHandleRef.current = asyncHandle;
          currentUnsubRef.current = asyncHandle.subscribe(updateFromState);
          updateFromState(asyncHandle.getState());
          asyncHandle.promise.catch(() => {});
        }
        // In params mode, onExecution callback already fired synchronously
      } else {
        // Sync operation
        const syncHandle = handle as SyncOperationHandle<TResult>;
        dispatch({ type: "syncResult", payload: syncHandle.result });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, key],
  );

  // --- Immediate ---

  useEffect(() => {
    if (!options?.immediate) return;
    execute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    execute,
    data: snapshot.data,
    state: snapshot.state,
    isLoading: snapshot.isLoading,
    isSuccess: snapshot.isSuccess,
    isError: snapshot.isError,
    isCancelled: snapshot.isCancelled,
    error: snapshot.error,
  };
}

// ---------------------------------------------------------------------------
// useStore
// ---------------------------------------------------------------------------

function depsEqual(a: DependencyList, b: DependencyList): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

const noopInit = () => Promise.resolve();

// Overload: without init
export function useStore<S extends StateSchema, Ops extends OperationsSchema>(
  factory: () => AsyncStore<S, Ops>,
  deps: DependencyList,
): AsyncStore<S, Ops>;

// Overload: with init
export function useStore<S extends StateSchema, Ops extends OperationsSchema>(
  factory: () => AsyncStore<S, Ops>,
  init: (store: AsyncStore<S, Ops>) => Promise<void>,
  deps: DependencyList,
): AsyncStore<S, Ops>;

// Implementation
export function useStore<S extends StateSchema, Ops extends OperationsSchema>(
  factory: () => AsyncStore<S, Ops>,
  initOrDeps: ((store: AsyncStore<S, Ops>) => Promise<void>) | DependencyList,
  maybeDeps?: DependencyList,
): AsyncStore<S, Ops> {
  const hasInit = typeof initOrDeps === "function";
  const init = hasInit
    ? (initOrDeps as (store: AsyncStore<S, Ops>) => Promise<void>)
    : noopInit;
  const deps = hasInit ? maybeDeps! : (initOrDeps as DependencyList);

  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const initRef = useRef(init);
  initRef.current = init;

  const [store, setStore] = useState(() => factoryRef.current());

  // Track deps changes via version counter
  const depsRef = useRef(deps);
  const versionRef = useRef(0);
  if (!depsEqual(depsRef.current, deps)) {
    depsRef.current = deps;
    versionRef.current++;
  }
  const version = versionRef.current;

  // Run init on first mount
  useEffect(() => {
    initRef.current(store).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On deps change: create new store, init, swap when settled
  useEffect(() => {
    if (version === 0) return;

    let cancelled = false;
    let promoted = false;
    const newStore = factoryRef.current();

    initRef.current(newStore).then(
      () => {
        if (!cancelled) {
          promoted = true;
          setStore(newStore);
        }
      },
      () => {
        // Swap anyway on init failure
        if (!cancelled) {
          promoted = true;
          setStore(newStore);
        }
      },
    );

    return () => {
      cancelled = true;
      if (!promoted) {
        newStore.destroy();
      }
    };
  }, [version]);

  // Destroy active store when swapped out or on unmount
  useEffect(() => {
    return () => store.destroy();
  }, [store]);

  return store;
}
