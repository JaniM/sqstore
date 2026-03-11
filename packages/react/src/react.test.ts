// @vitest-environment jsdom
import { createStore } from "@sqstore/core";
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, test } from "vitest";
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

    const { result, unmount } = renderHook(() => useSlot(store, "counter"));
    expect(result.current).toBe(42);

    unmount();
    store.destroy();
  });

  test("value updates on slot change", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() => useSlot(store, "counter"));
    expect(result.current).toBe(0);

    act(() => {
      store.operations.increment();
    });
    expect(result.current).toBe(1);

    unmount();
    store.destroy();
  });

  test("tracks multiple consecutive changes", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() => useSlot(store, "counter"));

    act(() => {
      store.operations.setCounter(10);
    });
    expect(result.current).toBe(10);

    act(() => {
      store.operations.setCounter(20);
    });
    expect(result.current).toBe(20);

    act(() => {
      store.operations.setCounter(30);
    });
    expect(result.current).toBe(30);

    unmount();
    store.destroy();
  });

  test("unsubscribes on unmount", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() => useSlot(store, "counter"));

    act(() => {
      store.operations.setCounter(5);
    });
    expect(result.current).toBe(5);

    unmount();

    store.operations.setCounter(99);
    // After unmount, the hook no longer tracks — result is stale
    expect(result.current).toBe(5);

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

    const { result, unmount } = renderHook(() =>
      useSlot(store, "items", (items) => items[1]),
    );
    expect(result.current).toBe("b");

    unmount();
    store.destroy();
  });

  test("updates when selected value changes", () => {
    const store = createListStore();

    const { result, unmount } = renderHook(() =>
      useSlot(store, "items", (items) => items[1]),
    );

    expect(result.current).toBe("b");

    act(() => {
      store.operations.setItems(["a", "z", "c"]);
    });
    expect(result.current).toBe("z");

    unmount();
    store.destroy();
  });

  test("skips re-render when selected value unchanged", () => {
    const store = createListStore();
    let renderCount = 0;

    const { result, unmount } = renderHook(() => {
      renderCount++;
      return useSlot(store, "items", (items) => items[1]);
    });

    expect(result.current).toBe("b");
    const rendersAfterMount = renderCount;

    // Mutate items[0] but keep items[1] the same
    act(() => {
      store.operations.setItems(["x", "b", "c"]);
    });

    // Should NOT have re-rendered because "b" === "b"
    expect(renderCount).toBe(rendersAfterMount);
    expect(result.current).toBe("b");

    unmount();
    store.destroy();
  });

  test("works with object selector returning same reference", () => {
    const store = createStore(
      { data: { id: 1 } },
      ({ set }) => ({
        setData: {
          type: "sync" as const,
          execute: (params: { id: number }) => {
            set("data", params);
          },
        },
      }),
    );

    const { result, unmount } = renderHook(() =>
      useSlot(store, "data", (data) => data.id),
    );

    expect(result.current).toBe(1);

    // Change the object but keep the selected field the same
    act(() => {
      store.operations.setData({ id: 1 });
    });
    expect(result.current).toBe(1);

    // Now change the selected field
    act(() => {
      store.operations.setData({ id: 2 });
    });
    expect(result.current).toBe(2);

    unmount();
    store.destroy();
  });
});

// ============================================================================
// useOperation — sync operations
// ============================================================================

describe("useOperation — sync operations", () => {
  test("initial state: all fields inert", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() => useOperation(store, "getCounter"));

    expect(result.current.data).toBe(undefined);
    expect(result.current.state).toBe(null);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.isCancelled).toBe(false);
    expect(result.current.error).toBe(undefined);

    unmount();
    store.destroy();
  });

  test("after execute: data holds result", () => {
    const store = createCounterStore();
    store.operations.setCounter(42);

    const { result, unmount } = renderHook(() => useOperation(store, "getCounter"));

    act(() => {
      result.current.execute();
    });
    expect(result.current.data).toBe(42);

    unmount();
    store.destroy();
  });

  test("lifecycle fields stay inert after execute", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() => useOperation(store, "getCounter"));

    act(() => {
      result.current.execute();
    });

    expect(result.current.state).toBe(null);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.isCancelled).toBe(false);

    unmount();
    store.destroy();
  });

  test("multiple executes update data", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() => useOperation(store, "getCounter"));

    act(() => {
      store.operations.setCounter(10);
      result.current.execute();
    });
    expect(result.current.data).toBe(10);

    act(() => {
      store.operations.setCounter(20);
      result.current.execute();
    });
    expect(result.current.data).toBe(20);

    unmount();
    store.destroy();
  });

  test("parameterized sync ops", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() => useOperation(store, "setCounter"));

    act(() => {
      result.current.execute(77);
    });
    expect(store.get("counter")).toBe(77);

    unmount();
    store.destroy();
  });
});

// ============================================================================
// useOperation — async operations
// ============================================================================

describe("useOperation — async operations", () => {
  test("before execute: initial values", () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() => useOperation(store, "fetchData"));

    expect(result.current.data).toBe(undefined);
    expect(result.current.state).toBe(null);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.isCancelled).toBe(false);
    expect(result.current.error).toBe(undefined);

    unmount();
    store.destroy();
  });

  test("loading state after execute", () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() => useOperation(store, "fetchData"));

    act(() => {
      result.current.execute("test");
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.state?.status).toBe("loading");

    unmount();
    store.destroy();
  });

  test("success after resolution", async () => {
    const { store, resolve } = createAsyncStore();

    const { result, unmount } = renderHook(() => useOperation(store, "fetchData"));

    act(() => {
      result.current.execute("test");
    });

    await act(async () => {
      resolve("hello world");
      await flush();
    });

    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toBe("hello world");

    unmount();
    store.destroy();
  });

  test("error after rejection", async () => {
    const { store, reject } = createAsyncStore();

    const { result, unmount } = renderHook(() => useOperation(store, "fetchData"));

    act(() => {
      result.current.execute("test");
    });

    await act(async () => {
      reject(new Error("network failure"));
      await flush();
    });

    expect(result.current.isError).toBe(true);
    expect(result.current.error?.message).toBe("network failure");

    unmount();
    store.destroy();
  });

  test("re-execute cancels previous, tracks new", async () => {
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

    const { result, unmount } = renderHook(() => useOperation(store2, "fetchData"));

    act(() => {
      result.current.execute("first");
    });

    // Second execute cancels first
    act(() => {
      result.current.execute("second");
    });

    await act(async () => {
      await flush();
    });

    // Second is loading
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolve2("second result");
      await flush();
    });

    expect(result.current.data).toBe("second result");
    expect(result.current.isSuccess).toBe(true);

    unmount();
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

    const { result, unmount } = renderHook(() => useOperation(store, "fetchData"));

    act(() => {
      result.current.execute("first");
    });

    // Resolve first invocation
    await act(async () => {
      resolve1("first result");
      await flush();
    });

    expect(result.current.data).toBe("first result");
    expect(result.current.isSuccess).toBe(true);

    // Re-execute — data should retain previous result while loading
    act(() => {
      result.current.execute("second");
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBe("first result");

    // Resolve second invocation
    await act(async () => {
      resolve2("second result");
      await flush();
    });

    expect(result.current.data).toBe("second result");
    expect(result.current.isSuccess).toBe(true);

    unmount();
    store.destroy();
  });

  test("state.data contains the result on success", async () => {
    const { store, resolve } = createAsyncStore();

    const { result, unmount } = renderHook(() => useOperation(store, "fetchData"));

    act(() => {
      result.current.execute("test");
    });

    await act(async () => {
      resolve("from-state");
      await flush();
    });

    expect(result.current.state?.data).toBe("from-state");
    expect(result.current.state?.isSuccess).toBe(true);

    unmount();
    store.destroy();
  });

  test("unmount cancels invocation when cancelOnUnmount: true", async () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchData", { cancelOnUnmount: true }),
    );

    act(() => {
      result.current.execute("test");
    });

    expect(result.current.isLoading).toBe(true);

    // Unmount — should cancel the async handle
    unmount();

    // data should remain undefined since we never resolved
    expect(result.current.data).toBe(undefined);

    store.destroy();
  });

  test("unmount does NOT cancel by default", async () => {
    const { store, resolve } = createAsyncStore();

    const { result, unmount } = renderHook(() => useOperation(store, "fetchData"));

    act(() => {
      result.current.execute("test");
    });

    expect(result.current.isLoading).toBe(true);

    // Unmount without cancelOnUnmount — should NOT cancel
    unmount();

    // Resolve after unmount — onSuccess should still fire
    resolve("post-unmount");
    await flush();

    expect(store.get("result")).toBe("post-unmount");

    store.destroy();
  });
});

// ============================================================================
// useOperation — immediate option
// ============================================================================

describe("useOperation — immediate option", () => {
  test("immediate: true (void-param async)", () => {
    const { store } = createVoidAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetch", { immediate: true }),
    );

    expect(result.current.isLoading).toBe(true);

    unmount();
    store.destroy();
  });

  test("immediate: true with params (parameterized async)", () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchData", {
        params: "auto-param",
        immediate: true,
      }),
    );

    expect(result.current.isLoading).toBe(true);

    unmount();
    store.destroy();
  });

  test("immediate: true (void-param sync)", () => {
    const store = createCounterStore();
    store.operations.setCounter(99);

    const { result, unmount } = renderHook(() =>
      useOperation(store, "getCounter", { immediate: true }),
    );

    expect(result.current.data).toBe(99);

    unmount();
    store.destroy();
  });

  test("immediate: true without params auto-executes (non-void op)", () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchData", { immediate: true }),
    );

    // Should have called execute with undefined params — still triggers loading
    expect(result.current.isLoading).toBe(true);

    unmount();
    store.destroy();
  });

  test("immediate: true works under React.StrictMode", async () => {
    const { store, resolve } = createVoidAsyncStore();

    const { result, unmount } = renderHook(
      () => useOperation(store, "fetch", { immediate: true }),
      { wrapper: StrictMode },
    );

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolve("done");
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toBe("done");

    unmount();
    store.destroy();
  });
});

// ============================================================================
// useOperation — params option
// ============================================================================

describe("useOperation — params option", () => {
  test("execute() uses default params", () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchData", { params: "default-param" }),
    );

    act(() => {
      result.current.execute();
    });

    expect(result.current.isLoading).toBe(true);

    unmount();
    store.destroy();
  });

  test("immediate: true with params auto-executes", () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchData", {
        params: "auto-param",
        immediate: true,
      }),
    );

    expect(result.current.isLoading).toBe(true);

    unmount();
    store.destroy();
  });

  test("passive tracking: tracks matching lane key", async () => {
    const { store, resolve } = createKeyedAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchItem", { params: { id: 1 } }),
    );

    // Trigger operation directly on the store (not via execute)
    act(() => {
      store.operations.fetchItem({ id: 1 });
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolve("item-1-data");
      await flush();
    });

    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toBe("item-1-data");

    unmount();
    store.destroy();
  });

  test("passive tracking: ignores non-matching lane key", () => {
    const { store } = createKeyedAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchItem", { params: { id: 1 } }),
    );

    // Trigger a different entity — suppress unhandled rejection from destroy()
    act(() => {
      const handle = store.operations.fetchItem({ id: 2 });
      handle.promise.catch(() => {});
    });

    // Hook should NOT track the other lane
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBe(undefined);

    unmount();
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

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchItem", { params: { id: 1 } }),
    );

    act(() => {
      result.current.execute(); // first call
    });

    expect(result.current.isLoading).toBe(true);

    // Second call on same lane — cancelPrevious aborts the first
    act(() => {
      result.current.execute();
    });

    await act(async () => {
      await flush();
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolve2("second-result");
      await flush();
    });

    expect(result.current.data).toBe("second-result");
    expect(result.current.isSuccess).toBe(true);

    unmount();
    store.destroy();
  });

  test("unmount does NOT cancel tracked handle (passive)", async () => {
    const { store, resolve } = createKeyedAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchItem", { params: { id: 1 } }),
    );

    act(() => {
      result.current.execute();
    });

    // Unmount — passive observer should NOT cancel the handle
    unmount();

    // Resolve after unmount
    resolve("post-dispose-data");
    await flush();

    // The onSuccess callback should still have run (state slot updated)
    expect(store.get("items")).toEqual({ 1: "post-dispose-data" });

    store.destroy();
  });

  test("unmount without params cancels when cancelOnUnmount: true (regression)", async () => {
    const { store } = createAsyncStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "fetchData", { cancelOnUnmount: true }),
    );

    act(() => {
      result.current.execute("test");
    });

    expect(result.current.isLoading).toBe(true);

    unmount();

    // data should remain undefined since we never resolved and handle was cancelled
    expect(result.current.data).toBe(undefined);

    store.destroy();
  });

  test("sync operation with params uses defaults", () => {
    const store = createCounterStore();

    const { result, unmount } = renderHook(() =>
      useOperation(store, "setCounter", { params: 42 }),
    );

    act(() => {
      result.current.execute();
    });

    expect(store.get("counter")).toBe(42);

    unmount();
    store.destroy();
  });
});
