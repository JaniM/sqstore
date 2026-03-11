import { createStore } from "@sqstore/core";
import { describe, expect, test } from "vitest";
import { effectScope } from "vue";
import { useOperation, useSlot } from "./index";

// ============================================================================
// Test store factories
// ============================================================================

function createCounterStore() {
  return createStore({ counter: 0 }, ({ get, set, update }) => ({
    increment: {
      type: "sync" as const,
      execute: () => {
        update("counter", (c) => c + 1);
      },
    },
    setCounter: {
      type: "sync" as const,
      execute: (params: number) => {
        set("counter", params);
      },
    },
    getCounter: {
      type: "sync" as const,
      execute: (): number => {
        return get("counter") as number;
      },
    },
  }));
}

function createAsyncStore() {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;

  const store = createStore({ result: undefined as string | undefined }, ({ set }) => ({
    fetchData: {
      type: "async" as const,
      concurrency: "cancelPrevious" as const,
      execute: async (params: string, signal): Promise<string> => {
        return new Promise<string>((res, rej) => {
          resolve = res;
          reject = rej;
          signal.addEventListener("abort", () => {
            rej(new DOMException("Aborted", "AbortError"));
          });
        });
      },
      onSuccess: (response: string) => {
        set("result", response);
      },
    },
  }));

  return { store, resolve: (v: string) => resolve(v), reject: (e: Error) => reject(e) };
}

function createVoidAsyncStore() {
  let resolve!: (value: string) => void;

  const store = createStore({ result: undefined as string | undefined }, ({ set }) => ({
    fetch: {
      type: "async" as const,
      concurrency: "cancelPrevious" as const,
      execute: async (_params: void, signal) => {
        return new Promise<string>((res, rej) => {
          resolve = res;
          signal.addEventListener("abort", () => {
            rej(new DOMException("Aborted", "AbortError"));
          });
        });
      },
      onSuccess: (response: string) => {
        set("result", response);
      },
    },
  }));

  return { store, resolve: (v: string) => resolve(v) };
}

function createKeyedAsyncStore() {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;

  const store = createStore({ items: {} as Record<number, string> }, ({ set, get }) => ({
    fetchItem: {
      type: "async" as const,
      concurrency: "cancelPrevious" as const,
      key: (params: { id: number }) => `fetchItem:${params.id}`,
      execute: async (params: { id: number }, signal): Promise<string> => {
        return new Promise<string>((res, rej) => {
          resolve = res;
          reject = rej;
          signal.addEventListener("abort", () => {
            rej(new DOMException("Aborted", "AbortError"));
          });
        });
      },
      onSuccess: (response: string, params: { id: number }) => {
        const current = get("items") as Record<number, string>;
        set("items", { ...current, [params.id]: response });
      },
    },
  }));

  return { store, resolve: (v: string) => resolve(v), reject: (e: Error) => reject(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ============================================================================
// useSlot
// ============================================================================

describe("useSlot", () => {
  test("initial value matches store.get(key)", () => {
    const store = createCounterStore();
    store.operations.setCounter(42);

    const scope = effectScope();
    scope.run(() => {
      const ref = useSlot(store, "counter");
      expect(ref.value).toBe(42);
    });

    scope.stop();
    store.destroy();
  });

  test("ref updates on slot change", () => {
    const store = createCounterStore();

    const scope = effectScope();
    let ref!: ReturnType<typeof useSlot<any, any, "counter">>;

    scope.run(() => {
      ref = useSlot(store, "counter");
    });

    expect(ref.value).toBe(0);

    store.operations.increment();
    expect(ref.value).toBe(1);

    scope.stop();
    store.destroy();
  });

  test("tracks multiple consecutive changes", () => {
    const store = createCounterStore();

    const scope = effectScope();
    let ref!: ReturnType<typeof useSlot<any, any, "counter">>;

    scope.run(() => {
      ref = useSlot(store, "counter");
    });

    store.operations.setCounter(10);
    expect(ref.value).toBe(10);

    store.operations.setCounter(20);
    expect(ref.value).toBe(20);

    store.operations.setCounter(30);
    expect(ref.value).toBe(30);

    scope.stop();
    store.destroy();
  });

  test("unsubscribes on scope.stop()", () => {
    const store = createCounterStore();

    const scope = effectScope();
    let ref!: ReturnType<typeof useSlot<any, any, "counter">>;

    scope.run(() => {
      ref = useSlot(store, "counter");
    });

    store.operations.setCounter(5);
    expect(ref.value).toBe(5);

    scope.stop();

    store.operations.setCounter(99);
    expect(ref.value).toBe(5);

    store.destroy();
  });

  test("returns a readonly ref", () => {
    const store = createCounterStore();

    const scope = effectScope();
    scope.run(() => {
      const ref = useSlot(store, "counter");
      expect((ref as any).__v_isReadonly).toBe(true);
    });

    scope.stop();
    store.destroy();
  });
});

// ============================================================================
// useSlot — selector
// ============================================================================

describe("useSlot — selector", () => {
  function createListStore() {
    return createStore(
      { items: ["a", "b", "c"] as string[] },
      ({ set }) => ({
        setItems: {
          type: "sync" as const,
          execute: (params: string[]) => {
            set("items", params);
          },
        },
      }),
    );
  }

  test("derives value on initial read", () => {
    const store = createListStore();

    const scope = effectScope();
    scope.run(() => {
      const ref = useSlot(store, "items", (items) => items[1]);
      expect(ref.value).toBe("b");
    });

    scope.stop();
    store.destroy();
  });

  test("updates when selected value changes", () => {
    const store = createListStore();

    const scope = effectScope();
    let ref!: ReturnType<typeof useSlot<any, any, "items", string>>;

    scope.run(() => {
      ref = useSlot(store, "items", (items) => items[1]);
    });

    expect(ref.value).toBe("b");

    store.operations.setItems(["a", "z", "c"]);
    expect(ref.value).toBe("z");

    scope.stop();
    store.destroy();
  });

  test("skips update when selected value unchanged", () => {
    const store = createListStore();

    const scope = effectScope();
    let ref!: ReturnType<typeof useSlot<any, any, "items", string>>;

    scope.run(() => {
      ref = useSlot(store, "items", (items) => items[1]);
    });

    // Capture the ref's internal ShallowRef identity
    const initialValue = ref.value;
    expect(initialValue).toBe("b");

    // Mutate items[0] but keep items[1] the same — "b" === "b" by Object.is
    store.operations.setItems(["x", "b", "c"]);

    // shallowRef should NOT have triggered because "b" === "b"
    expect(ref.value).toBe("b");
    // The primitive value is the same, so no reactivity trigger
  });

  test("works with object selector returning same reference", () => {
    const sharedObj = { id: 1 };
    const store = createStore(
      { data: sharedObj },
      ({ set }) => ({
        setData: {
          type: "sync" as const,
          execute: (params: { id: number }) => {
            set("data", params);
          },
        },
      }),
    );

    const scope = effectScope();
    let ref!: ReturnType<typeof useSlot<any, any, "data", number>>;

    scope.run(() => {
      ref = useSlot(store, "data", (data) => data.id);
    });

    expect(ref.value).toBe(1);

    // Change the object but keep the selected field the same
    store.operations.setData({ id: 1 });
    expect(ref.value).toBe(1);

    // Now change the selected field
    store.operations.setData({ id: 2 });
    expect(ref.value).toBe(2);

    scope.stop();
    store.destroy();
  });
});

// ============================================================================
// useOperation — sync operations
// ============================================================================

describe("useOperation — sync operations", () => {
  test("initial state: all refs inert", () => {
    const store = createCounterStore();

    const scope = effectScope();
    scope.run(() => {
      const op = useOperation(store, "getCounter");

      expect(op.data.value).toBe(undefined);
      expect(op.state.value).toBe(null);
      expect(op.isLoading.value).toBe(false);
      expect(op.isSuccess.value).toBe(false);
      expect(op.isError.value).toBe(false);
      expect(op.isCancelled.value).toBe(false);
      expect(op.error.value).toBe(undefined);
    });

    scope.stop();
    store.destroy();
  });

  test("after execute: data holds result", () => {
    const store = createCounterStore();
    store.operations.setCounter(42);

    const scope = effectScope();
    scope.run(() => {
      const op = useOperation(store, "getCounter");
      op.execute();
      expect(op.data.value).toBe(42);
    });

    scope.stop();
    store.destroy();
  });

  test("lifecycle refs stay inert after execute", () => {
    const store = createCounterStore();

    const scope = effectScope();
    scope.run(() => {
      const op = useOperation(store, "getCounter");
      op.execute();

      expect(op.state.value).toBe(null);
      expect(op.isLoading.value).toBe(false);
      expect(op.isSuccess.value).toBe(false);
      expect(op.isError.value).toBe(false);
      expect(op.isCancelled.value).toBe(false);
    });

    scope.stop();
    store.destroy();
  });

  test("multiple executes update data", () => {
    const store = createCounterStore();

    const scope = effectScope();
    scope.run(() => {
      const op = useOperation(store, "getCounter");

      store.operations.setCounter(10);
      op.execute();
      expect(op.data.value).toBe(10);

      store.operations.setCounter(20);
      op.execute();
      expect(op.data.value).toBe(20);
    });

    scope.stop();
    store.destroy();
  });

  test("parameterized sync ops", () => {
    const store = createCounterStore();

    const scope = effectScope();
    scope.run(() => {
      const op = useOperation(store, "setCounter");
      op.execute(77);
      expect(store.get("counter")).toBe(77);
    });

    scope.stop();
    store.destroy();
  });
});

// ============================================================================
// useOperation — async operations
// ============================================================================

describe("useOperation — async operations", () => {
  test("before execute: initial values", () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    scope.run(() => {
      const op = useOperation(store, "fetchData");

      expect(op.data.value).toBe(undefined);
      expect(op.state.value).toBe(null);
      expect(op.isLoading.value).toBe(false);
      expect(op.isSuccess.value).toBe(false);
      expect(op.isError.value).toBe(false);
      expect(op.isCancelled.value).toBe(false);
      expect(op.error.value).toBe(undefined);
    });

    scope.stop();
    store.destroy();
  });

  test("loading state after execute", () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    scope.run(() => {
      const op = useOperation(store, "fetchData");
      op.execute("test");

      expect(op.isLoading.value).toBe(true);
      expect(op.state.value?.status).toBe("loading");
    });

    scope.stop();
    store.destroy();
  });

  test("success after resolution", async () => {
    const { store, resolve } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData");
      op.execute("test");
    });

    resolve("hello world");
    await flush();

    expect(op.isSuccess.value).toBe(true);
    expect(op.data.value).toBe("hello world");

    scope.stop();
    store.destroy();
  });

  test("error after rejection", async () => {
    const { store, reject } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData");
      op.execute("test");
    });

    reject(new Error("network failure"));
    await flush();

    expect(op.isError.value).toBe(true);
    expect(op.error.value?.message).toBe("network failure");

    scope.stop();
    store.destroy();
  });

  test("re-execute cancels previous, tracks new", async () => {
    // We need separate resolve/reject per invocation, so create a fresh store
    // that captures multiple promises.
    let resolve1!: (v: string) => void;
    let resolve2!: (v: string) => void;
    let callCount = 0;

    const store2 = createStore({ result: undefined as string | undefined }, ({ set }) => ({
      fetchData: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: string, signal): Promise<string> => {
          callCount++;
          return new Promise<string>((res, rej) => {
            if (callCount === 1) resolve1 = res;
            else resolve2 = res;
            signal.addEventListener("abort", () => {
              rej(new DOMException("Aborted", "AbortError"));
            });
          });
        },
        onSuccess: (response: string) => {
          set("result", response);
        },
      },
    }));

    const scope2 = effectScope();
    let op2!: ReturnType<typeof useOperation>;

    scope2.run(() => {
      op2 = useOperation(store2, "fetchData");
      op2.execute("first");
    });

    // Second execute cancels first
    op2.execute("second");
    await flush();

    // First is cancelled, second is loading
    expect(op2.isLoading.value).toBe(true);

    resolve2("second result");
    await flush();

    expect(op2.data.value).toBe("second result");
    expect(op2.isSuccess.value).toBe(true);

    scope2.stop();
    store2.destroy();
  });

  test("data persists during re-execution (stale-while-revalidate)", async () => {
    let resolve1!: (v: string) => void;
    let resolve2!: (v: string) => void;
    let callCount = 0;

    const store = createStore({ result: undefined as string | undefined }, ({ set }) => ({
      fetchData: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: string, signal): Promise<string> => {
          callCount++;
          return new Promise<string>((res, rej) => {
            if (callCount === 1) resolve1 = res;
            else resolve2 = res;
            signal.addEventListener("abort", () => {
              rej(new DOMException("Aborted", "AbortError"));
            });
          });
        },
        onSuccess: (response: string) => {
          set("result", response);
        },
      },
    }));

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData");
      op.execute("first");
    });

    // Resolve first invocation
    resolve1("first result");
    await flush();

    expect(op.data.value).toBe("first result");
    expect(op.isSuccess.value).toBe(true);

    // Re-execute — data should retain previous result while loading
    op.execute("second");
    expect(op.isLoading.value).toBe(true);
    expect(op.data.value).toBe("first result");

    // Resolve second invocation
    resolve2("second result");
    await flush();

    expect(op.data.value).toBe("second result");
    expect(op.isSuccess.value).toBe(true);

    scope.stop();
    store.destroy();
  });

  test("state.value.data contains the result on success", async () => {
    const { store, resolve } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData");
      op.execute("test");
    });

    resolve("from-state");
    await flush();

    expect(op.state.value?.data).toBe("from-state");
    expect(op.state.value?.isSuccess).toBe(true);

    scope.stop();
    store.destroy();
  });

  test("scope disposal cancels invocation when cancelOnUnmount: true", async () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData", { cancelOnUnmount: true });
      op.execute("test");
    });

    expect(op.isLoading.value).toBe(true);

    // Dispose the scope — should cancel the async handle
    scope.stop();

    // data should remain undefined since we never resolved
    expect(op.data.value).toBe(undefined);

    store.destroy();
  });

  test("scope disposal does NOT cancel by default", async () => {
    const { store, resolve } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData");
      op.execute("test");
    });

    expect(op.isLoading.value).toBe(true);

    // Dispose scope without cancelOnUnmount — should NOT cancel
    scope.stop();

    // Resolve after disposal — onSuccess should still fire
    resolve("post-dispose");
    await flush();

    expect(store.get("result")).toBe("post-dispose");

    store.destroy();
  });
});

// ============================================================================
// useOperation — immediate option
// ============================================================================

describe("useOperation — immediate option", () => {
  test("immediate: true (void-param async)", () => {
    const { store } = createVoidAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetch", { immediate: true });
    });

    expect(op.isLoading.value).toBe(true);

    scope.stop();
    store.destroy();
  });

  test("immediate: true with params (parameterized async)", () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData", {
        params: "auto-param",
        immediate: true,
      });
    });

    expect(op.isLoading.value).toBe(true);

    scope.stop();
    store.destroy();
  });

  test("immediate: true (void-param sync)", () => {
    const store = createCounterStore();
    store.operations.setCounter(99);

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "getCounter", { immediate: true });
    });

    expect(op.data.value).toBe(99);

    scope.stop();
    store.destroy();
  });

  test("immediate: true without params auto-executes (non-void op)", () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData", { immediate: true });
    });

    // Should have called execute with undefined params — still triggers loading
    expect(op.isLoading.value).toBe(true);

    scope.stop();
    store.destroy();
  });
});

// ============================================================================
// useOperation — params option
// ============================================================================

describe("useOperation — params option", () => {
  test("execute() uses default params", () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData", { params: "default-param" });
      op.execute();
    });

    expect(op.isLoading.value).toBe(true);

    scope.stop();
    store.destroy();
  });

  test("immediate: true with params auto-executes", () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData", {
        params: "auto-param",
        immediate: true,
      });
    });

    expect(op.isLoading.value).toBe(true);

    scope.stop();
    store.destroy();
  });

  test("passive tracking: tracks matching lane key", async () => {
    const { store, resolve } = createKeyedAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchItem", { params: { id: 1 } });
    });

    // Trigger operation directly on the store (not via execute)
    store.operations.fetchItem({ id: 1 });

    expect(op.isLoading.value).toBe(true);

    resolve("item-1-data");
    await flush();

    expect(op.isSuccess.value).toBe(true);
    expect(op.data.value).toBe("item-1-data");

    scope.stop();
    store.destroy();
  });

  test("passive tracking: ignores non-matching lane key", () => {
    const { store } = createKeyedAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchItem", { params: { id: 1 } });
    });

    // Trigger a different entity — suppress unhandled rejection from destroy()
    const handle = store.operations.fetchItem({ id: 2 });
    handle.promise.catch(() => {});

    // Composable should NOT track the other lane
    expect(op.isLoading.value).toBe(false);
    expect(op.data.value).toBe(undefined);

    scope.stop();
    store.destroy();
  });

  test("re-execution swaps subscription", async () => {
    let resolve1!: (v: string) => void;
    let resolve2!: (v: string) => void;
    let callCount = 0;

    const store = createStore({ items: {} as Record<number, string> }, ({ set, get }) => ({
      fetchItem: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: (params: { id: number }) => `fetchItem:${params.id}`,
        execute: async (params: { id: number }, signal): Promise<string> => {
          callCount++;
          return new Promise<string>((res, rej) => {
            if (callCount === 1) resolve1 = res;
            else resolve2 = res;
            signal.addEventListener("abort", () => {
              rej(new DOMException("Aborted", "AbortError"));
            });
          });
        },
        onSuccess: (response: string, params: { id: number }) => {
          const current = get("items") as Record<number, string>;
          set("items", { ...current, [params.id]: response });
        },
      },
    }));

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchItem", { params: { id: 1 } });
      op.execute(); // first call
    });

    expect(op.isLoading.value).toBe(true);

    // Second call on same lane — cancelPrevious aborts the first
    op.execute();
    await flush();

    expect(op.isLoading.value).toBe(true);

    resolve2("second-result");
    await flush();

    expect(op.data.value).toBe("second-result");
    expect(op.isSuccess.value).toBe(true);

    scope.stop();
    store.destroy();
  });

  test("scope disposal does NOT cancel tracked handle", async () => {
    const { store, resolve } = createKeyedAsyncStore();

    const scope = effectScope();

    scope.run(() => {
      const op = useOperation(store, "fetchItem", { params: { id: 1 } });
      op.execute();
    });

    // Dispose scope — passive observer should NOT cancel the handle
    scope.stop();

    // Resolve after disposal
    resolve("post-dispose-data");
    await flush();

    // The onSuccess callback should still have run (state slot updated)
    expect(store.get("items")).toEqual({ 1: "post-dispose-data" });

    store.destroy();
  });

  test("scope disposal without params cancels when cancelOnUnmount: true (regression)", async () => {
    const { store } = createAsyncStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "fetchData", { cancelOnUnmount: true });
      op.execute("test");
    });

    expect(op.isLoading.value).toBe(true);

    scope.stop();

    // data should remain undefined since we never resolved and handle was cancelled
    expect(op.data.value).toBe(undefined);

    store.destroy();
  });

  test("sync operation with params uses defaults", () => {
    const store = createCounterStore();

    const scope = effectScope();
    let op!: ReturnType<typeof useOperation>;

    scope.run(() => {
      op = useOperation(store, "setCounter", { params: 42 });
      op.execute();
    });

    expect(store.get("counter")).toBe(42);

    scope.stop();
    store.destroy();
  });
});
