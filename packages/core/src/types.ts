// ============================================================================
// Async Request Store — Type Definitions
//
// Two-layer architecture:
//   • State Slots  — named, typed containers for data. Subscribable.
//   • Operations   — well-typed callable functions. Two kinds:
//                      - Async: arbitrary async function with managed
//                               concurrency, retry, cancellation, and
//                               optional store-first resolution. Each
//                               invocation returns a handle with its own
//                               observable lifecycle.
//                      - Sync:  pure state mutations, execute immediately,
//                               throw on error, return a result.
//
// Operations are defined via a factory function that receives the store's
// typed operations object and state access methods. This allows operations
// to chain other operations and access state with full type safety via
// closure.
//
// Requires TypeScript >= 5.4 (for NoInfer).
// ============================================================================

// ---------------------------------------------------------------------------
// 1. Utility types
// ---------------------------------------------------------------------------

/**
 * Recursively makes all properties readonly.
 * Prevents consumers from mutating state read from the store.
 *
 * Built-in objects (Date, RegExp, Error, Function) and primitives are
 * passed through unchanged.
 */
export type DeepReadonly<T> = T extends Primitive | BuiltIn
  ? T
  : T extends Array<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends Map<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends Set<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : { readonly [K in keyof T]: DeepReadonly<T[K]> };

type Primitive = string | number | boolean | bigint | symbol | undefined | null;
type BuiltIn = Date | RegExp | Error | Function;

// ---------------------------------------------------------------------------
// 2. Concurrency strategies
// ---------------------------------------------------------------------------

/**
 * Defines how the store handles a new invocation when one is already
 * in-flight for the same operation.
 *
 * - "cancelPrevious": Abort the in-flight request, start the new one.
 * - "enqueue":        Wait for the in-flight request to settle, then start.
 * - "deduplicate":    Reuse the in-flight request; return its handle.
 */
export type ConcurrencyStrategy = "cancelPrevious" | "enqueue" | "deduplicate";

// ---------------------------------------------------------------------------
// 3. Retry configuration
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Maximum number of automatic retries after a failure. Default: 0 */
  maxRetries?: number;

  /**
   * Delay (ms) before each retry. Can be a fixed number or a function
   * that receives the attempt index (0-based) for exponential backoff.
   */
  retryDelay?: number | ((attempt: number) => number);
}

// ---------------------------------------------------------------------------
// 4. State schema — the registry of state slots
// ---------------------------------------------------------------------------

/**
 * Maps state slot names to their data types.
 *
 * @example
 * ```ts
 * interface MyState {
 *   currentPost: Post | undefined;
 *   posts:       Record<number, Post>;
 *   currentUser: User;
 * }
 * ```
 */
export interface StateSchema {
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// 5. State slot value — what the store holds per slot
// ---------------------------------------------------------------------------

export interface SlotState<TData> {
  /** The current data in this slot (deeply readonly). */
  data: DeepReadonly<TData>;
}

// ---------------------------------------------------------------------------
// 6. State reader — read-only access for resolve checks and execution
// ---------------------------------------------------------------------------

/**
 * Read-only view of state slots. Passed to `resolve` and async `execute`
 * so they can inspect the store without mutating it.
 *
 * @typeParam S - The full StateSchema.
 */
export interface StateReader<S extends StateSchema> {
  /** Read the current data in a slot (deeply readonly). */
  get<K extends keyof S & string>(key: K): DeepReadonly<S[K]>;
}

// ---------------------------------------------------------------------------
// 7. State mutator — read/write access for updaters and sync operations
// ---------------------------------------------------------------------------

/**
 * Provides typed read/write access to state slots.
 *
 * @typeParam S - The full StateSchema.
 */
export interface StateMutator<S extends StateSchema> extends StateReader<S> {
  /** Overwrite the data in a slot. */
  set<K extends keyof S & string>(key: K, value: S[K]): void;

  /**
   * Update a slot by applying a function to its current value.
   * Useful for immutable patches, filtering lists, etc.
   */
  update<K extends keyof S & string>(key: K, updater: (current: S[K]) => S[K]): void;
}

// ---------------------------------------------------------------------------
// 8. Operation definitions
// ---------------------------------------------------------------------------

/**
 * An async operation that runs an arbitrary async function and optionally
 * updates state slots with the result.
 *
 * The store manages the lifecycle (concurrency, retry, cancellation)
 * around the executor — the executor just does the async work.
 *
 * @typeParam TResponse - The type returned by the executor.
 * @typeParam TParams   - Parameters required to invoke the operation.
 *                        Use `void` if it takes no parameters.
 */
export interface AsyncOperationDefinition<TResponse = unknown, TParams = void> {
  type: "async";

  /** How to handle concurrent invocations of this operation. */
  concurrency: ConcurrencyStrategy;

  /**
   * Derives the concurrency key for an invocation from its params.
   * Invocations with the same key are subject to the concurrency strategy.
   *
   * If omitted, all invocations of this operation share a single
   * concurrency lane (keyed by operation name alone).
   *
   * @example
   * ```ts
   * // Per-entity concurrency: getPost({ id: 1 }) and getPost({ id: 2 })
   * // are independent, but two getPost({ id: 1 }) calls compete.
   * key: (params) => `getPost:${params.id}`
   * ```
   */
  key?: (params: TParams) => string;

  /** Retry configuration for this operation. */
  retry?: RetryConfig;

  /**
   * Returns concurrency lane keys that must settle before this operation
   * begins (runs before `resolve`). Use `getLaneKey` on other operations
   * to obtain their lane keys.
   *
   * **Warning:** Circular dependencies will deadlock — the store does not
   * detect them.
   *
   * @example
   * ```ts
   * // Wait for any in-flight save of the same entity before fetching.
   * waitFor: (params) => [store.operations.savePost.getLaneKey({ id: params.id })]
   * ```
   */
  waitFor?: (params: TParams) => string[];

  /**
   * The async function that performs the actual work.
   *
   * Receives the params and an AbortSignal as separate arguments.
   * State is accessed via closure from the factory context.
   *
   * Should NOT trigger other operations — use `onSuccess`/`onError`
   * for chaining, since `execute` may be retried.
   *
   * @example
   * ```ts
   * execute: async (params, signal) => {
   *   const res = await fetch(`/api/posts/${params.id}`, { signal });
   *   if (!res.ok) throw new Error(`HTTP ${res.status}`);
   *   return res.json() as Promise<Post>;
   * }
   * ```
   */
  execute: (params: TParams, signal: AbortSignal) => Promise<TResponse>;

  /**
   * Called before running the executor. Inspects the current store
   * state (via closure) and returns a value if the operation can be
   * resolved without executing.
   *
   * - Return `TResponse`: Skip the executor. The returned value is passed
   *   to `onSuccess` and resolved via the handle's promise.
   * - Return `undefined`: Proceed with the executor as normal.
   *
   * The return type is `DeepReadonly<TResponse> | undefined` because values
   * typically come from `get()` which returns deeply frozen data.
   */
  resolve?: (params: TParams) => DeepReadonly<TResponse> | undefined;

  /**
   * Called on a successful execution (or a successful resolve).
   * Use the closure-captured state methods to update state slots.
   *
   * To chain other operations, use the factory closure variable.
   *
   * Receives the original params so updaters can reference them.
   * If omitted, no state slots are updated (fire-and-forget).
   */
  onSuccess?: (response: TResponse, params: TParams) => void;

  /**
   * Optional handler called when the operation fails (after all retries).
   * Can be used to clear or roll back state slots, or chain fallback
   * operations via the factory closure.
   */
  onError?: (error: Error, params: TParams) => void;
}

/**
 * A sync operation that immediately mutates state slots without any
 * async work. Has no concurrency strategy, retry, or cancellation.
 *
 * State is accessed via closure from the factory context.
 *
 * @typeParam TResult - The return type of the execute function.
 *                      Use `void` if it returns nothing.
 * @typeParam TParams - Parameters required to invoke the operation.
 *                      Use `void` if it takes no parameters.
 */
export interface SyncOperationDefinition<TResult = void, TParams = void> {
  type: "sync";

  /**
   * Synchronously mutate state slots (via closure) and optionally return
   * a value.
   *
   * To chain other operations, use the factory closure variable.
   * If this function throws, the error propagates directly to the caller.
   */
  execute: (params: TParams) => TResult;
}

/**
 * Discriminated union of all operation kinds.
 */
export type OperationDefinition<TResult = any, TParams = any> =
  | AsyncOperationDefinition<TResult, TParams>
  | SyncOperationDefinition<TResult, TParams>;

// ---------------------------------------------------------------------------
// 10. Operations schema
// ---------------------------------------------------------------------------

export type OperationsSchema = {
  [key: string]: OperationDefinition<any, any>;
};

// ---------------------------------------------------------------------------
// 11. Type-level helpers
// ---------------------------------------------------------------------------

/**
 * Extract the params type of any operation. Handles zero-param operations
 * where `execute` takes no arguments.
 *
 * Uses tuple extraction (`Parameters<execute>`) to distinguish `() => ...`
 * from `(params: P, ...) => ...`, since in TypeScript a zero-arg
 * function is structurally assignable to a one-arg function.
 */
export type ParamsOf<Op> = Op extends { execute: (...args: infer A) => any }
  ? A extends [infer TParams, ...any[]]
    ? TParams
    : void
  : void;

/** Extract the result type of any operation. */
export type ResultOf<Op> = Op extends {
  type: "async";
  execute: (...args: any[]) => Promise<infer TResponse>;
}
  ? TResponse
  : Op extends { type: "sync"; execute: (...args: any[]) => infer TResult }
    ? TResult
    : void;

// ---------------------------------------------------------------------------
// 12. Invocation state — lifecycle of a single async operation call
// ---------------------------------------------------------------------------

export type InvocationStatus = "loading" | "success" | "error" | "cancelled";

export interface InvocationState<TResponse = unknown> {
  /** Current lifecycle status of this invocation. */
  status: InvocationStatus;

  /** Error from this invocation, if it failed. */
  error: Error | undefined;

  /** The operation result on success, `undefined` otherwise. */
  data: TResponse | undefined;

  /** Whether this invocation was resolved from the store (via `resolve`). */
  resolvedFromStore: boolean;

  /** Convenience boolean flags. */
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isCancelled: boolean;

  /** How many retries have been attempted for this invocation. */
  retryCount: number;
}

// ---------------------------------------------------------------------------
// 13. Operation handles
// ---------------------------------------------------------------------------

/**
 * Handle for a single invocation of an **async** operation.
 */
export interface AsyncOperationHandle<TResponse> extends PromiseLike<TResponse> {
  /** Resolves with the response (executed or store-resolved), or rejects. */
  promise: Promise<TResponse>;

  /** The AbortController governing this invocation. */
  controller: AbortController;

  /** Convenience: calls controller.abort(). No-op if already settled. */
  cancel: () => void;

  /** Read the current lifecycle state of this invocation. */
  getState: () => InvocationState<TResponse>;

  /** Subscribe to lifecycle changes of this invocation. */
  subscribe: (callback: InvocationChangeCallback<TResponse>) => Unsubscribe;
}

/**
 * Handle for a single invocation of a **sync** operation.
 *
 * Sync operations execute immediately and return their result.
 * If execute() throws, the error propagates directly to the caller.
 */
export interface SyncOperationHandle<TResult> {
  /** The return value of execute(). */
  result: TResult;
}

/**
 * Narrows the handle type based on the operation definition.
 * Uses the `type` discriminant to distinguish async from sync.
 */
export type OperationHandle<Op> = Op extends {
  type: "async";
  execute: (...args: any[]) => Promise<infer TResponse>;
}
  ? AsyncOperationHandle<TResponse>
  : Op extends { type: "sync"; execute: (...args: any[]) => infer TResult }
    ? SyncOperationHandle<TResult>
    : never;

// ---------------------------------------------------------------------------
// 14. Typed operation functions
// ---------------------------------------------------------------------------

/**
 * An async operation callable: the invoke function intersected with
 * a `getLaneKey` method that returns the concurrency lane key for
 * the given params.
 */
type AsyncOperationCallable<Op> = (ParamsOf<Op> extends void
  ? () => OperationHandle<Op>
  : (params: ParamsOf<Op>) => OperationHandle<Op>) & {
  getLaneKey: ParamsOf<Op> extends void ? () => string : (params: ParamsOf<Op>) => string;
};

/**
 * Converts an OperationsSchema into a record of callable, well-typed
 * functions. Each function takes the operation's params (if any) and
 * returns the appropriate handle.
 *
 * Async operations additionally expose a `getLaneKey` method.
 */
export type StoreOperations<Ops extends OperationsSchema> = {
  [K in keyof Ops & string]: Ops[K] extends { type: "async" }
    ? AsyncOperationCallable<Ops[K]>
    : ParamsOf<Ops[K]> extends void
      ? () => OperationHandle<Ops[K]>
      : (params: ParamsOf<Ops[K]>) => OperationHandle<Ops[K]>;
};

// ---------------------------------------------------------------------------
// 14b. Utility type — filter to async operation keys only
// ---------------------------------------------------------------------------

/**
 * Extracts keys from an OperationsSchema that correspond to async operations.
 */
export type AsyncOperationKeys<Ops extends OperationsSchema> = {
  [K in keyof Ops & string]: Ops[K] extends { type: "async" } ? K : never;
}[keyof Ops & string];

// ---------------------------------------------------------------------------
// 15. Subscription callbacks
// ---------------------------------------------------------------------------

/** Callback for state slot changes. */
export type SlotChangeCallback<TData> = (state: SlotState<TData>) => void;

/** Callback for async invocation lifecycle changes. */
export type InvocationChangeCallback<TResponse = unknown> = (
  state: InvocationState<TResponse>,
) => void;

/** Callback for `onExecution` — notified when an async operation is invoked. */
export type ExecutionCallback<TResponse = unknown, TParams = unknown> = (
  handle: AsyncOperationHandle<TResponse>,
  params: TParams,
) => void;

/** Unsubscribe function. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// 16. Store configuration
// ---------------------------------------------------------------------------

export interface StoreConfig {
  /** Global default retry config (overridden per operation). */
  retry?: RetryConfig;
}

// ---------------------------------------------------------------------------
// 17. Factory context — passed to the operation factory
// ---------------------------------------------------------------------------

/**
 * Context provided to the operation factory function.
 * Contains the operations proxy and typed state access methods.
 *
 * The `operations` field is typed as `any` because including the generic
 * `Ops` type (even via `NoInfer`) prevents TypeScript from inferring `Ops`
 * from the factory's return type. Operations chaining inside the factory
 * works via the runtime proxy — type safety is provided on the store's
 * `operations` property (the public API), not inside the factory.
 *
 * @typeParam S - The StateSchema (state slot types).
 */
export interface FactoryContext<S extends StateSchema> {
  /**
   * Lazy proxy for calling other operations. Typed as `any` inside the
   * factory to preserve inference of `Ops` from the return type. The
   * store's public `operations` property is fully typed.
   */
  operations: any;

  /** Read the current data in a state slot (deeply readonly). */
  get: <K extends keyof S & string>(key: K) => DeepReadonly<S[K]>;

  /** Overwrite the data in a state slot. */
  set: <K extends keyof S & string>(key: K, value: S[K]) => void;

  /** Update a state slot by applying a function to its current value. */
  update: <K extends keyof S & string>(key: K, updater: (current: S[K]) => S[K]) => void;
}

// ---------------------------------------------------------------------------
// 18. The Store interface
// ---------------------------------------------------------------------------

/**
 * @typeParam S   - The StateSchema (state slot types).
 * @typeParam Ops - The OperationsSchema (operation definitions).
 */
export interface AsyncStore<S extends StateSchema, Ops extends OperationsSchema> {
  /**
   * Well-typed callable operations.
   *
   * @example
   * ```ts
   * // Async — returns a handle with lifecycle and cancellation
   * const handle = store.operations.getPost({ id: 42 });
   * handle.subscribe((s) => { if (s.isLoading) showSpinner(); });
   * const post = await handle.promise;
   * handle.cancel();
   *
   * // Or await directly — the handle is a PromiseLike
   * const post = await store.operations.getPost({ id: 42 });
   *
   * // Sync — executes immediately, throws on error
   * store.operations.clearCurrentPost();
   * const { result: count } = store.operations.getPostCount();
   * ```
   */
  operations: StoreOperations<Ops>;

  /** Read the current data in a state slot (deeply readonly). */
  get<K extends keyof S & string>(key: K): DeepReadonly<S[K]>;

  /** Subscribe to changes in a state slot. Returns an unsubscribe function. */
  subscribe<K extends keyof S & string>(key: K, callback: SlotChangeCallback<S[K]>): Unsubscribe;

  /**
   * Subscribe to all future invocations of an async operation.
   *
   * The callback fires synchronously before the handle is returned to the
   * caller, so `handle.subscribe()` will catch the very first state transition.
   *
   * @returns An unsubscribe function.
   */
  onExecution<K extends AsyncOperationKeys<Ops>>(
    key: K,
    callback: ExecutionCallback<ResultOf<Ops[K]>, ParamsOf<Ops[K]>>,
  ): Unsubscribe;

  /** Cancel all in-flight async operations and reset the store. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// 19. Store factory
// ---------------------------------------------------------------------------

/**
 * Creates a configured AsyncStore instance.
 *
 * Operations are defined via a factory function that receives a context
 * with the store's typed `operations` proxy and state access methods
 * (`get`, `set`, `update`). This allows any operation to chain other
 * operations and access state with full type safety via closure — no
 * string keys, no loose dispatch types.
 *
 * The `operations` object in the context is a lazy reference that
 * is fully wired up before any operations execute, so it is safe to
 * capture in closures within `onSuccess`, `onError`, and sync `execute`.
 *
 * Uses `NoInfer` on the factory parameter to break circular type inference:
 * TypeScript infers `Ops` purely from the factory's return type, then
 * retroactively types the `operations` parameter.
 *
 * @typeParam S   - The StateSchema (state slot types).
 * @typeParam Ops - The OperationsSchema (inferred from the factory return).
 *
 * @example
 * ```ts
 * interface AppState {
 *   currentPost: Post | undefined;
 *   posts:       Record<number, Post>;
 *   comments:    Comment[];
 * }
 *
 * const store = createStore<AppState>(
 *   { currentPost: undefined, posts: {}, comments: [] },
 *   ({ operations, get, set, update }) => ({
 *
 *     getPost: {
 *       type: "async" as const,
 *       concurrency: "deduplicate" as const,
 *       key: (params: { id: number }) => `getPost:${params.id}`,
 *       retry: { maxRetries: 2 },
 *
 *       resolve: (params: { id: number }) => {
 *         return get("posts")[params.id];
 *       },
 *
 *       execute: async (params, signal) => {
 *         const res = await fetch(`/api/posts/${params.id}`, { signal });
 *         if (!res.ok) throw new Error(`HTTP ${res.status}`);
 *         return res.json() as Promise<Post>;
 *       },
 *
 *       onSuccess: (post, params) => {
 *         set("currentPost", post);
 *         update("posts", (posts) => ({
 *           ...posts,
 *           [params.id]: post,
 *         }));
 *         // Chain: fetch comments for the post (fully typed!)
 *         operations.getComments({ postId: params.id });
 *       },
 *     },
 *
 *     getComments: {
 *       type: "async" as const,
 *       concurrency: "cancelPrevious" as const,
 *
 *       execute: async (params, signal) => {
 *         const res = await fetch(
 *           `/api/posts/${params.postId}/comments`,
 *           { signal },
 *         );
 *         if (!res.ok) throw new Error(`HTTP ${res.status}`);
 *         return res.json() as Promise<Comment[]>;
 *       },
 *
 *       onSuccess: (comments) => {
 *         set("comments", comments);
 *       },
 *     },
 *
 *     clearCurrentPost: {
 *       type: "sync" as const,
 *       execute: () => {
 *         set("currentPost", undefined);
 *       },
 *     },
 *
 *   }),
 * );
 * ```
 */
export type CreateStore = <S extends StateSchema, Ops extends OperationsSchema>(
  initialState: S,
  factory: (context: FactoryContext<S>) => Ops,
  config?: StoreConfig,
) => AsyncStore<S, Ops>;
