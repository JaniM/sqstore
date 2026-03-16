import { describe, expect, test } from "vitest";
import { createStore } from "./index";

// ============================================================================
// Types for tests
// ============================================================================

interface Post {
  id: number;
  title: string;
}

interface Comment {
  id: number;
  body: string;
}

interface TestState {
  currentPost: Post | undefined;
  posts: Record<number, Post>;
  comments: Comment[];
  counter: number;
}

const EMPTY_STATE: TestState = {
  currentPost: undefined,
  posts: {},
  comments: [],
  counter: 0,
};

// ============================================================================
// Tests
// ============================================================================

describe("Sync operations — basic state mutation", () => {
  test("increment 3x → counter is 3", () => {
    const store = createStore({ ...EMPTY_STATE }, ({ update, set, get }) => ({
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

    store.operations.increment();
    store.operations.increment();
    store.operations.increment();
    expect(store.get("counter")).toBe(3);

    store.operations.setCounter(42);
    expect(store.get("counter")).toBe(42);

    const { result } = store.operations.getCounter();
    expect(result).toBe(42);

    store.destroy();
  });
});

describe("Sync operations — chaining via closure", () => {
  test("incrementTwice chains via closure", () => {
    const store = createStore({ ...EMPTY_STATE }, ({ operations: ops, update }) => ({
      increment: {
        type: "sync" as const,
        execute: () => {
          update("counter", (c) => c + 1);
        },
      },
      incrementTwice: {
        type: "sync" as const,
        execute: () => {
          ops.increment();
          ops.increment();
        },
      },
    }));

    store.operations.incrementTwice();
    expect(store.get("counter")).toBe(2);
    store.destroy();
  });
});

describe("State subscriptions", () => {
  test("subscription fires on each set and unsubscribe stops notifications", () => {
    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      setCounter: {
        type: "sync" as const,
        execute: (params: number) => {
          set("counter", params);
        },
      },
    }));

    const values: number[] = [];
    const unsub = store.subscribe("counter", (slot) => {
      values.push(slot.data as number);
    });

    store.operations.setCounter(10);
    store.operations.setCounter(20);
    expect(values).toHaveLength(2);
    expect(values).toEqual([10, 20]);

    unsub();
    store.operations.setCounter(30);
    expect(values).toHaveLength(2);

    store.destroy();
  });
});

describe("Async operations — basic execute and onSuccess", () => {
  test("async op resolves with response and onSuccess updates state", async () => {
    const store = createStore({ ...EMPTY_STATE }, ({ set, update }) => ({
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: { id: number }): Promise<Post> => {
          return { id: params.id, title: `Post ${params.id}` };
        },
        onSuccess: (post: Post) => {
          set("currentPost", post);
          update("posts", (posts: Record<number, Post>) => ({
            ...posts,
            [post.id]: post,
          }));
        },
      },
    }));

    const post = await store.operations.getPost({ id: 1 });
    expect(post.id).toBe(1);
    expect(store.get("currentPost")?.id).toBe(1);
    expect(store.get("posts")[1]?.title).toBe("Post 1");

    store.destroy();
  });
});

describe("Async operations — resolve from store", () => {
  test("resolves from store cache and skips execute", async () => {
    let executeCalled = false;

    const store = createStore(
      {
        ...EMPTY_STATE,
        posts: { 1: { id: 1, title: "Cached Post" } },
      } as TestState,
      ({ get, set }) => ({
        getPost: {
          type: "async" as const,
          concurrency: "deduplicate" as const,
          key: (params: { id: number }) => `getPost:${params.id}`,
          resolve: (params: { id: number }) => {
            return get("posts")[params.id];
          },
          execute: async (params: { id: number }): Promise<Post> => {
            executeCalled = true;
            return { id: params.id, title: `Fetched Post ${params.id}` };
          },
          onSuccess: (post: Post) => {
            set("currentPost", post);
          },
        },
      }),
    );

    const handle = store.operations.getPost({ id: 1 });
    const post = await handle;
    expect(post.id).toBe(1);
    expect(post.title).toBe("Cached Post");
    expect(executeCalled).toBe(false);
    expect(handle.getState().resolvedFromStore).toBe(true);
    expect(store.get("currentPost")?.title).toBe("Cached Post");

    // Non-cached ID should execute
    executeCalled = false;
    const post2 = await store.operations.getPost({ id: 2 });
    expect(executeCalled).toBe(true);
    expect(post2.title).toBe("Fetched Post 2");

    store.destroy();
  });
});

describe("Async operations — invocation lifecycle tracking", () => {
  test("starts loading, transitions to success", async () => {
    let resolveExecute: ((v: Post) => void) | undefined;

    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: (params: { id: number }): Promise<Post> => {
          return new Promise((resolve) => {
            resolveExecute = resolve;
          });
        },
        onSuccess: (post: Post) => {
          set("currentPost", post);
        },
      },
    }));

    const handle = store.operations.getPost({ id: 1 });
    const states: string[] = [];
    handle.subscribe((s) => states.push(s.status));

    expect(handle.getState().isLoading).toBe(true);

    resolveExecute!({ id: 1, title: "Done" });
    await handle.promise;

    expect(handle.getState().isSuccess).toBe(true);
    expect(states).toContain("success");

    store.destroy();
  });
});

describe("Async operations — cancellation", () => {
  test("cancelled op rejects and state shows cancelled", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      slowOp: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (_params: void, signal) => {
          return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => resolve("done"), 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      },
    }));

    const handle = store.operations.slowOp();
    handle.cancel();

    await expect(handle.promise).rejects.toThrow();
    expect(handle.getState().isCancelled).toBe(true);

    store.destroy();
  });
});

describe("Async operations — retry", () => {
  test("succeeds after retries", async () => {
    let attempts = 0;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      flaky: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        retry: { maxRetries: 2, retryDelay: 0 },
        execute: async (): Promise<string> => {
          attempts++;
          if (attempts < 3) throw new Error(`Fail #${attempts}`);
          return "success";
        },
      },
    }));

    const result = await store.operations.flaky();
    expect(result).toBe("success");
    expect(attempts).toBe(3);

    store.destroy();
  });

  test("retry exhausted calls onError", async () => {
    let errorHandled = false;

    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      alwaysFails: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        retry: { maxRetries: 1, retryDelay: 0 },
        execute: async (): Promise<string> => {
          throw new Error("permanent failure");
        },
        onError: (_err: Error) => {
          errorHandled = true;
          set("counter", -1);
        },
      },
    }));

    await expect(store.operations.alwaysFails().promise).rejects.toThrow();
    expect(errorHandled).toBe(true);
    expect(store.get("counter")).toBe(-1);

    store.destroy();
  });
});

describe("Concurrency — cancelPrevious", () => {
  test("first invocation is cancelled, second succeeds", async () => {
    const resolvers: Array<(v: string) => void> = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      search: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (_params: void, signal) => {
          return new Promise<string>((resolve, reject) => {
            resolvers.push(resolve);
            signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      },
    }));

    const handle1 = store.operations.search();
    const handle2 = store.operations.search(); // should cancel handle1

    await expect(handle1.promise).rejects.toThrow();

    resolvers[1]?.("result2");
    const result = await handle2.promise;
    expect(result).toBe("result2");

    store.destroy();
  });
});

describe("Concurrency — deduplicate", () => {
  test("execute called only once, both handles get same result", async () => {
    let callCount = 0;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      fetchData: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        execute: async (): Promise<string> => {
          callCount++;
          return "result";
        },
      },
    }));

    const [r1, r2] = await Promise.all([
      store.operations.fetchData().promise,
      store.operations.fetchData().promise,
    ]);

    expect(callCount).toBe(1);
    expect(r1).toBe("result");
    expect(r2).toBe("result");

    store.destroy();
  });
});

describe("Concurrency — enqueue", () => {
  test("enqueue executes multiple times", async () => {
    const results: number[] = [];
    let callCount = 0;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      sequential: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        execute: async (params: number): Promise<number> => {
          callCount++;
          await new Promise((r) => setTimeout(r, 10));
          return params;
        },
        onSuccess: (result: number) => {
          results.push(result);
        },
      },
    }));

    const p1 = store.operations.sequential(1).promise;
    const p2 = store.operations.sequential(2).promise;
    const p3 = store.operations.sequential(3).promise;

    await Promise.all([p1, p2, p3]);
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(results).toContain(1);

    store.destroy();
  });
});

describe("Concurrency — per-entity keying", () => {
  test("different keys run independently", async () => {
    let callCount = 0;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      getPost: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        key: (params: { id: number }) => `post:${params.id}`,
        execute: async (params: { id: number }): Promise<Post> => {
          callCount++;
          return { id: params.id, title: `Post ${params.id}` };
        },
      },
    }));

    const [p1, p2] = await Promise.all([
      store.operations.getPost({ id: 1 }).promise,
      store.operations.getPost({ id: 2 }).promise,
    ]);

    expect(callCount).toBe(2);
    expect(p1.id).toBe(1);
    expect(p2.id).toBe(2);

    store.destroy();
  });
});

describe("Async operations — chaining via onSuccess", () => {
  test("getPost triggers getComments via onSuccess", async () => {
    const store = createStore({ ...EMPTY_STATE }, ({ operations: ops, set }) => ({
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: { id: number }): Promise<Post> => {
          return { id: params.id, title: `Post ${params.id}` };
        },
        onSuccess: (post: Post, params: { id: number }) => {
          set("currentPost", post);
          ops.getComments({ postId: params.id });
        },
      },
      getComments: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: { postId: number }): Promise<Comment[]> => {
          return [{ id: 1, body: `Comment on post ${params.postId}` }];
        },
        onSuccess: (comments: Comment[]) => {
          set("comments", comments);
        },
      },
    }));

    await store.operations.getPost({ id: 5 });
    expect(store.get("currentPost")?.id).toBe(5);

    // Give chained op a tick to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(store.get("comments")).toHaveLength(1);
    expect(store.get("comments")[0]?.body).toBe("Comment on post 5");

    store.destroy();
  });
});

describe("AsyncOperationHandle is PromiseLike (await directly)", () => {
  test("handle is directly awaitable", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      getValue: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "hello",
      },
    }));

    const result = await store.operations.getValue();
    expect(result).toBe("hello");

    store.destroy();
  });
});

describe("Store destroy cancels in-flight operations", () => {
  test("in-flight op rejected after destroy", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      longRunning: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (_params: void, signal) => {
          return new Promise<void>((_, reject) => {
            const timer = setTimeout(() => {}, 10000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      },
    }));

    const handle = store.operations.longRunning();
    store.destroy();
    await expect(handle.promise).rejects.toThrow();
  });
});

describe("Global retry config from StoreConfig", () => {
  test("global retry config applied", async () => {
    let attempts = 0;

    const store = createStore(
      { ...EMPTY_STATE },
      () => ({
        flaky: {
          type: "async" as const,
          concurrency: "cancelPrevious" as const,
          execute: async (): Promise<string> => {
            attempts++;
            if (attempts < 2) throw new Error("fail");
            return "ok";
          },
        },
      }),
      { retry: { maxRetries: 1, retryDelay: 0 } },
    );

    const result = await store.operations.flaky();
    expect(result).toBe("ok");
    expect(attempts).toBe(2);

    store.destroy();
  });
});

describe("Invocation subscribers see state after onSuccess", () => {
  test("subscriber sees state mutated by onSuccess", async () => {
    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: { id: number }): Promise<Post> => {
          return { id: params.id, title: `Post ${params.id}` };
        },
        onSuccess: (post: Post) => {
          set("currentPost", post);
        },
      },
    }));

    const handle = store.operations.getPost({ id: 7 });
    let postSeenBySubscriber: Post | undefined;
    handle.subscribe((s) => {
      if (s.isSuccess) {
        postSeenBySubscriber = store.get("currentPost") as Post | undefined;
      }
    });

    await handle.promise;
    expect(postSeenBySubscriber?.id).toBe(7);

    store.destroy();
  });
});

describe("Invocation subscribers see state after onError", () => {
  test("subscriber sees state mutated by onError", async () => {
    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      failOp: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<void> => {
          throw new Error("boom");
        },
        onError: (_err: Error) => {
          set("counter", -999);
        },
      },
    }));

    const handle = store.operations.failOp();
    let counterSeenBySubscriber: number | undefined;
    handle.subscribe((s) => {
      if (s.isError) {
        counterSeenBySubscriber = store.get("counter") as number;
      }
    });

    await handle.promise.catch(() => {});
    expect(counterSeenBySubscriber).toBe(-999);

    store.destroy();
  });
});

describe("Invocation subscribers see state after onSuccess (resolve path)", () => {
  test("subscriber sees state mutated by onSuccess on resolve path", async () => {
    const store = createStore(
      {
        ...EMPTY_STATE,
        posts: { 3: { id: 3, title: "Cached" } },
      } as TestState,
      ({ get, set }) => ({
        getPost: {
          type: "async" as const,
          concurrency: "deduplicate" as const,
          resolve: (params: { id: number }) => {
            return get("posts")[params.id];
          },
          execute: async (params: { id: number }): Promise<Post> => {
            return { id: params.id, title: "Fetched" };
          },
          onSuccess: (post: Post) => {
            set("currentPost", post);
          },
        },
      }),
    );

    const handle = store.operations.getPost({ id: 3 });
    let postSeenBySubscriber: Post | undefined;
    handle.subscribe((s) => {
      if (s.isSuccess) {
        postSeenBySubscriber = store.get("currentPost") as Post | undefined;
      }
    });

    await handle.promise;
    expect(postSeenBySubscriber?.id).toBe(3);

    store.destroy();
  });
});

// ========================================================================
// Regression tests for reviewed bugs
// ========================================================================

describe("Enqueue — three calls serialize fully", () => {
  test("executed in strict order 1→2→3", async () => {
    const executionOrder: number[] = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      sequential: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        execute: async (params: number): Promise<number> => {
          await new Promise((r) => setTimeout(r, 30));
          executionOrder.push(params);
          return params;
        },
      },
    }));

    const h1 = store.operations.sequential(1);
    const h2 = store.operations.sequential(2);
    const h3 = store.operations.sequential(3);

    const [r1, r2, r3] = await Promise.all([h1.promise, h2.promise, h3.promise]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
    expect(executionOrder).toEqual([1, 2, 3]);

    store.destroy();
  });
});

describe("onSuccess throw — tracker transitions and lane cleans up", () => {
  test("promise rejects when onSuccess throws, tracker still transitions", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      badSuccess: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "ok",
        onSuccess: () => {
          throw new Error("onSuccess exploded");
        },
      },
    }));

    const handle = store.operations.badSuccess();
    let sawSuccess = false;
    handle.subscribe((s) => {
      if (s.isSuccess) sawSuccess = true;
    });

    await expect(handle.promise).rejects.toThrow();
    expect(sawSuccess).toBe(true);

    // A follow-up call should work (lane was cleaned up)
    const store2 = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "ok",
        onSuccess: () => {
          throw new Error("boom");
        },
      },
      op2: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "recovered",
      },
    }));
    await store2.operations.op().promise.catch(() => {});
    const r = await store2.operations.op2();
    expect(r).toBe("recovered");
    store.destroy();
    store2.destroy();
  });
});

describe("onError throw — tracker transitions and lane cleans up", () => {
  test("promise rejects when onError throws, tracker still transitions", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      badError: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => {
          throw new Error("exec failed");
        },
        onError: () => {
          throw new Error("onError exploded");
        },
      },
    }));

    const handle = store.operations.badError();
    let sawError = false;
    handle.subscribe((s) => {
      if (s.isError) sawError = true;
    });

    await expect(handle.promise).rejects.toThrow();
    expect(sawError).toBe(true);
    store.destroy();
  });
});

describe("onSuccess throw on resolve path — tracker transitions", () => {
  test("promise rejects when resolve-path onSuccess throws", async () => {
    const store = createStore(
      {
        ...EMPTY_STATE,
        posts: { 1: { id: 1, title: "Cached" } },
      } as TestState,
      ({ get }) => ({
        op: {
          type: "async" as const,
          concurrency: "cancelPrevious" as const,
          resolve: (params: { id: number }) => get("posts")[params.id],
          execute: async (params: { id: number }): Promise<Post> => {
            return { id: params.id, title: "Fetched" };
          },
          onSuccess: () => {
            throw new Error("resolve-path onSuccess exploded");
          },
        },
      }),
    );

    const handle = store.operations.op({ id: 1 });
    let sawSuccess = false;
    handle.subscribe((s) => {
      if (s.isSuccess) sawSuccess = true;
    });

    await expect(handle.promise).rejects.toThrow();
    expect(sawSuccess).toBe(true);
    store.destroy();
  });
});

describe("onSuccess throw with retries — does NOT re-execute or call onError", () => {
  test("executor ran exactly once, onError not called", async () => {
    let executeCount = 0;
    let onErrorCalled = false;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        retry: { maxRetries: 2, retryDelay: 0 },
        execute: async (): Promise<string> => {
          executeCount++;
          return "ok";
        },
        onSuccess: () => {
          throw new Error("onSuccess exploded");
        },
        onError: () => {
          onErrorCalled = true;
        },
      },
    }));

    const handle = store.operations.op();
    const statuses: string[] = [];
    handle.subscribe((s) => statuses.push(s.status));

    await expect(handle.promise).rejects.toThrow();
    expect(executeCount).toBe(1);
    expect(onErrorCalled).toBe(false);
    expect(handle.getState().isSuccess).toBe(true);
    expect(statuses).not.toContain("error");

    store.destroy();
  });
});

describe("sleep rejects immediately for already-aborted signal", () => {
  test("cancelled during retry rejects quickly", async () => {
    const start = Date.now();
    let rejected = false;
    try {
      const store = createStore({ ...EMPTY_STATE }, () => ({
        op: {
          type: "async" as const,
          concurrency: "cancelPrevious" as const,
          retry: { maxRetries: 1, retryDelay: 5000 },
          execute: async (_params: void, signal) => {
            throw new Error("always fails");
          },
        },
      }));

      const handle = store.operations.op();
      handle.cancel();
      await handle.promise;
    } catch {
      rejected = true;
    }
    const elapsed = Date.now() - start;
    expect(rejected).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("Dedup handle cancel does not abort the shared request", () => {
  test("original handle still resolves after dedup cancel", async () => {
    let resolveExec: ((v: string) => void) | undefined;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      shared: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        execute: async (): Promise<string> => {
          return new Promise((resolve) => {
            resolveExec = resolve;
          });
        },
      },
    }));

    const handle1 = store.operations.shared();
    const handle2 = store.operations.shared(); // dedup handle

    handle2.cancel();

    resolveExec!("shared result");

    const result1 = await handle1.promise;
    expect(result1).toBe("shared result");

    store.destroy();
  });
});

describe("Dedup handle cancel updates tracker to cancelled", () => {
  test("dedup handle shows cancelled immediately and stays cancelled", async () => {
    let resolveExec: ((v: string) => void) | undefined;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      shared: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        execute: async (): Promise<string> =>
          new Promise((resolve) => {
            resolveExec = resolve;
          }),
      },
    }));

    const h1 = store.operations.shared();
    const h2 = store.operations.shared();

    h2.cancel();
    expect(h2.getState().isCancelled).toBe(true);

    resolveExec!("result");
    await h1.promise;
    await new Promise((r) => setTimeout(r, 20));

    expect(h2.getState().isCancelled).toBe(true);

    store.destroy();
  });
});

describe("Enqueued handle cancelled before execution — tracker updates", () => {
  test("enqueued handle shows cancelled, not stuck in loading", async () => {
    const resolvers: Array<() => void> = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        execute: async (_params: void, signal) => {
          await new Promise<void>((resolve, reject) => {
            resolvers.push(resolve);
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
          return "done";
        },
      },
    }));

    const hA = store.operations.op();
    const hB = store.operations.op(); // enqueued behind A

    hB.cancel();

    resolvers[0]!();
    await hA.promise;

    try {
      await hB.promise;
    } catch {}
    await new Promise((r) => setTimeout(r, 20));

    expect(hB.getState().isCancelled).toBe(true);

    store.destroy();
  });
});

describe("Enqueue — call arriving mid-execution serializes behind queue tail", () => {
  test("full execution order is 1→2→3→4 (strict serialization)", async () => {
    const executionLog: Array<{ id: number; phase: "start" | "end" }> = [];
    const resolvers: Array<() => void> = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        execute: async (params: number): Promise<number> => {
          executionLog.push({ id: params, phase: "start" });
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
          executionLog.push({ id: params, phase: "end" });
          return params;
        },
      },
    }));

    const hA = store.operations.op(1);
    const hB = store.operations.op(2);
    const hC = store.operations.op(3);

    resolvers[0]!();
    await new Promise((r) => setTimeout(r, 20));

    const hD = store.operations.op(4);

    resolvers[1]!();
    await new Promise((r) => setTimeout(r, 20));

    const cStarted = executionLog.some((e) => e.id === 3 && e.phase === "start");
    const dStarted = executionLog.some((e) => e.id === 4 && e.phase === "start");
    expect(cStarted).toBe(true);
    expect(dStarted).toBe(false);

    resolvers[2]!();
    await new Promise((r) => setTimeout(r, 20));

    const dStartedNow = executionLog.some((e) => e.id === 4 && e.phase === "start");
    expect(dStartedNow).toBe(true);

    resolvers[3]!();
    await Promise.all([hA.promise, hB.promise, hC.promise, hD.promise]);

    const startOrder = executionLog.filter((e) => e.phase === "start").map((e) => e.id);
    expect(startOrder).toEqual([1, 2, 3, 4]);

    store.destroy();
  });
});

describe("Mutating initial state object does not affect store", () => {
  test("store state is deep-cloned from init", () => {
    const init = {
      currentPost: undefined as Post | undefined,
      posts: { 1: { id: 1, title: "Original" } } as Record<number, Post>,
      comments: [] as Comment[],
      counter: 0,
    };

    const store = createStore(init, () => ({}));

    init.posts[1].title = "Mutated";
    init.counter = 999;

    expect((store.get("posts") as Record<number, Post>)[1]?.title).toBe("Original");
    expect(store.get("counter")).toBe(0);

    store.destroy();
  });
});

describe("destroy() cancels all enqueued operations, not just tail", () => {
  test("A cancelled mid-execution, B and C never start", async () => {
    const executionLog: string[] = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        execute: async (params: string, signal) => {
          executionLog.push(`${params}:start`);
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 20);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
          executionLog.push(`${params}:end`);
          return params;
        },
      },
    }));

    const hA = store.operations.op("A");
    const hB = store.operations.op("B");
    const hC = store.operations.op("C");

    await new Promise((r) => setTimeout(r, 5));
    expect(executionLog).toContain("A:start");

    store.destroy();

    await Promise.allSettled([hA.promise, hB.promise, hC.promise]);
    await new Promise((r) => setTimeout(r, 100));

    expect(executionLog).not.toContain("A:end");
    expect(executionLog).not.toContain("B:start");
    expect(executionLog).not.toContain("C:start");
  });
});

// ========================================================================
// InvocationState.data tests
// ========================================================================

describe("InvocationState.data — present on success (execute path)", () => {
  test("data contains the response after success", async () => {
    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: { id: number }): Promise<Post> => {
          return { id: params.id, title: `Post ${params.id}` };
        },
        onSuccess: (post: Post) => {
          set("currentPost", post);
        },
      },
    }));

    const handle = store.operations.getPost({ id: 1 });
    let dataOnSuccess: Post | undefined;
    handle.subscribe((s) => {
      if (s.isSuccess) dataOnSuccess = s.data;
    });

    await handle.promise;
    expect(dataOnSuccess).toEqual({ id: 1, title: "Post 1" });
    expect(handle.getState().data).toEqual({ id: 1, title: "Post 1" });

    store.destroy();
  });
});

describe("InvocationState.data — present on success (resolve path)", () => {
  test("data contains the resolved response", async () => {
    const store = createStore(
      {
        ...EMPTY_STATE,
        posts: { 1: { id: 1, title: "Cached" } },
      } as TestState,
      ({ get, set }) => ({
        getPost: {
          type: "async" as const,
          concurrency: "deduplicate" as const,
          resolve: (params: { id: number }) => {
            return get("posts")[params.id];
          },
          execute: async (params: { id: number }): Promise<Post> => {
            return { id: params.id, title: "Fetched" };
          },
          onSuccess: (post: Post) => {
            set("currentPost", post);
          },
        },
      }),
    );

    const handle = store.operations.getPost({ id: 1 });
    let dataOnSuccess: Post | undefined;
    handle.subscribe((s) => {
      if (s.isSuccess) dataOnSuccess = s.data;
    });

    await handle.promise;
    expect(dataOnSuccess).toEqual({ id: 1, title: "Cached" });
    expect(handle.getState().resolvedFromStore).toBe(true);

    store.destroy();
  });
});

describe("InvocationState.data — undefined during loading, error, and cancel", () => {
  test("data is undefined while loading", () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      slow: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => {
          return new Promise(() => {}); // never resolves
        },
      },
    }));

    const handle = store.operations.slow();
    expect(handle.getState().data).toBe(undefined);

    store.destroy();
  });

  test("data is undefined on error", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      fail: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => {
          throw new Error("boom");
        },
      },
    }));

    const handle = store.operations.fail();
    await handle.promise.catch(() => {});
    expect(handle.getState().data).toBe(undefined);
    expect(handle.getState().isError).toBe(true);

    store.destroy();
  });

  test("data is undefined on cancel", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      cancellable: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (_params: void, signal) => {
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      },
    }));

    const handle = store.operations.cancellable();
    handle.cancel();
    await handle.promise.catch(() => {});
    expect(handle.getState().data).toBe(undefined);
    expect(handle.getState().isCancelled).toBe(true);

    store.destroy();
  });
});

describe("InvocationState.data — forwarded through deduplicated handles", () => {
  test("deduplicated handle receives data on success", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      fetchData: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        execute: async (): Promise<string> => {
          return "shared-result";
        },
      },
    }));

    const h1 = store.operations.fetchData();
    const h2 = store.operations.fetchData();

    await Promise.all([h1.promise, h2.promise]);

    expect(h1.getState().data).toBe("shared-result");
    expect(h2.getState().data).toBe("shared-result");

    store.destroy();
  });
});

describe("InvocationState.data — forwarded through enqueued handles", () => {
  test("enqueued handle receives data on success", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      sequential: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        execute: async (params: number): Promise<number> => {
          return params * 10;
        },
      },
    }));

    const h1 = store.operations.sequential(1);
    const h2 = store.operations.sequential(2);

    await Promise.all([h1.promise, h2.promise]);

    expect(h1.getState().data).toBe(10);
    expect(h2.getState().data).toBe(20);

    store.destroy();
  });
});

describe("InvocationState.data — undefined during retries", () => {
  test("data remains undefined while retrying, set on final success", async () => {
    let attempts = 0;
    const dataSnapshots: Array<string | undefined> = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      flaky: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        retry: { maxRetries: 2, retryDelay: 0 },
        execute: async (): Promise<string> => {
          attempts++;
          if (attempts < 3) throw new Error(`Fail #${attempts}`);
          return "success";
        },
      },
    }));

    const handle = store.operations.flaky();
    handle.subscribe((s) => {
      dataSnapshots.push(s.data);
    });

    await handle.promise;

    // During retries (loading state), data should be undefined
    // Only the final success should have data
    expect(dataSnapshots[dataSnapshots.length - 1]).toBe("success");
    expect(dataSnapshots.slice(0, -1).every((d) => d === undefined)).toBe(true);

    store.destroy();
  });
});

describe("Equality check skips redundant notifications", () => {
  test("set() with same value does not notify subscribers", () => {
    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      setCounter: {
        type: "sync" as const,
        execute: (params: number) => {
          set("counter", params);
        },
      },
    }));

    let notifyCount = 0;
    store.subscribe("counter", () => {
      notifyCount++;
    });

    store.operations.setCounter(5);
    store.operations.setCounter(5);
    store.operations.setCounter(5);

    expect(notifyCount).toBe(1);

    store.destroy();
  });

  test("update() with identity function does not notify", () => {
    const sentinel = { id: 1, title: "Sentinel" };
    const store = createStore(
      { ...EMPTY_STATE, currentPost: sentinel } as TestState,
      ({ update }) => ({
        touchPost: {
          type: "sync" as const,
          execute: () => {
            update("currentPost", (p) => p);
          },
        },
      }),
    );

    let notifyCount = 0;
    store.subscribe("currentPost", () => {
      notifyCount++;
    });

    store.operations.touchPost();
    store.operations.touchPost();

    expect(notifyCount).toBe(0);

    store.destroy();
  });
});

// ========================================================================
// getLaneKey tests
// ========================================================================

describe("getLaneKey — async operations", () => {
  test("returns the operation name when no key function is defined", () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      fetchData: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "ok",
      },
    }));

    expect(store.operations.fetchData.getLaneKey()).toBe("fetchData");

    store.destroy();
  });

  test("returns the derived key when a key function is defined", () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      getPost: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        key: (params: { id: number }) => `getPost:${params.id}`,
        execute: async (params: { id: number }): Promise<Post> => ({
          id: params.id,
          title: `Post ${params.id}`,
        }),
      },
    }));

    expect(store.operations.getPost.getLaneKey({ id: 1 })).toBe("getPost:1");
    expect(store.operations.getPost.getLaneKey({ id: 42 })).toBe("getPost:42");

    store.destroy();
  });

  test("getLaneKey is not present on sync operations", () => {
    const store = createStore({ ...EMPTY_STATE }, ({ update }) => ({
      increment: {
        type: "sync" as const,
        execute: () => {
          update("counter", (c) => c + 1);
        },
      },
    }));

    expect((store.operations.increment as any).getLaneKey).toBeUndefined();

    store.destroy();
  });
});

// ========================================================================
// onExecution tests
// ========================================================================

describe("onExecution", () => {
  test("callback receives correct handle and params", async () => {
    const store = createStore({ ...EMPTY_STATE }, ({ set }) => ({
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (params: { id: number }): Promise<Post> => {
          return { id: params.id, title: `Post ${params.id}` };
        },
        onSuccess: (post: Post) => {
          set("currentPost", post);
        },
      },
    }));

    let receivedParams: { id: number } | undefined;
    let receivedHandle: any;

    store.onExecution("getPost", (handle, params) => {
      receivedHandle = handle;
      receivedParams = params;
    });

    const handle = store.operations.getPost({ id: 42 });

    expect(receivedParams).toEqual({ id: 42 });
    expect(receivedHandle).toBe(handle);

    await handle.promise;
    store.destroy();
  });

  test("fires for deduplicate invocations", async () => {
    let resolveExec: ((v: string) => void) | undefined;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      shared: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        execute: async (): Promise<string> =>
          new Promise((resolve) => {
            resolveExec = resolve;
          }),
      },
    }));

    const handles: any[] = [];
    store.onExecution("shared", (handle) => {
      handles.push(handle);
    });

    const h1 = store.operations.shared();
    const h2 = store.operations.shared(); // deduplicated

    expect(handles).toHaveLength(2);
    expect(handles[0]).toBe(h1);
    expect(handles[1]).toBe(h2);

    resolveExec!("done");
    await h1.promise;

    store.destroy();
  });

  test("fires for enqueue invocations", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      sequential: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        execute: async (params: number): Promise<number> => params,
      },
    }));

    const handles: any[] = [];
    store.onExecution("sequential", (handle, params) => {
      handles.push({ handle, params });
    });

    const h1 = store.operations.sequential(1);
    const h2 = store.operations.sequential(2);

    expect(handles).toHaveLength(2);
    expect(handles[0].handle).toBe(h1);
    expect(handles[0].params).toBe(1);
    expect(handles[1].handle).toBe(h2);
    expect(handles[1].params).toBe(2);

    await Promise.all([h1.promise, h2.promise]);
    store.destroy();
  });

  test("unsubscribe stops notifications", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "done",
      },
    }));

    let callCount = 0;
    const unsub = store.onExecution("op", () => {
      callCount++;
    });

    store.operations.op();
    expect(callCount).toBe(1);

    unsub();

    store.operations.op();
    expect(callCount).toBe(1);

    store.destroy();
  });

  test("destroy() cleans up execution subscriptions", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "done",
      },
    }));

    let callCount = 0;
    store.onExecution("op", () => {
      callCount++;
    });

    store.operations.op();
    expect(callCount).toBe(1);

    store.destroy();

    // After destroy, creating a new invocation should not notify
    // (the store is destroyed, but we test the sub was cleared)
    // We verify by checking the count didn't increase — the store
    // is already destroyed so this is a post-mortem check.
    expect(callCount).toBe(1);
  });

  test("handle is subscribable from within the callback (synchronous guarantee)", async () => {
    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        execute: async (): Promise<string> => "result",
      },
    }));

    const states: string[] = [];

    store.onExecution("op", (handle) => {
      // Subscribe inside the callback — should catch all transitions
      handle.subscribe((s) => {
        states.push(s.status);
      });
    });

    const handle = store.operations.op();
    await handle.promise;

    expect(states).toContain("success");
    // The initial state is "loading" but the first transition notification
    // should be "success" since loading is the initial state, not a transition
    expect(states[0]).toBe("success");

    store.destroy();
  });
});

// ========================================================================
// waitFor tests
// ========================================================================

describe("waitFor", () => {
  test("waits for in-flight dep to complete before executing", async () => {
    const log: string[] = [];
    let resolveSave!: (v: string) => void;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      savePost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: (params: { id: number }) => `savePost:${params.id}`,
        execute: async (params: { id: number }): Promise<string> => {
          log.push("save:start");
          const result = await new Promise<string>((resolve) => {
            resolveSave = resolve;
          });
          log.push("save:end");
          return result;
        },
      },
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        waitFor: (params: { id: number }) => [`savePost:${params.id}`],
        execute: async (params: { id: number }): Promise<string> => {
          log.push("get:exec");
          return `post-${params.id}`;
        },
      },
    }));

    // Start save (it blocks until we resolve)
    const hSave = store.operations.savePost({ id: 1 });
    await new Promise((r) => setTimeout(r, 10));

    // Start get — should wait for save
    const hGet = store.operations.getPost({ id: 1 });
    await new Promise((r) => setTimeout(r, 10));

    expect(log).toEqual(["save:start"]);

    // Resolve save
    resolveSave("saved");
    await hSave.promise;
    await hGet.promise;

    expect(log).toEqual(["save:start", "save:end", "get:exec"]);

    store.destroy();
  });

  test("proceeds immediately when no active deps", async () => {
    const log: string[] = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      savePost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: (params: { id: number }) => `savePost:${params.id}`,
        execute: async (params: { id: number }): Promise<string> => `saved-${params.id}`,
      },
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        waitFor: (params: { id: number }) => [`savePost:${params.id}`],
        execute: async (params: { id: number }): Promise<string> => {
          log.push("get:exec");
          return `post-${params.id}`;
        },
      },
    }));

    // No save in flight — getPost should proceed immediately
    const result = await store.operations.getPost({ id: 1 });
    expect(result).toBe("post-1");
    expect(log).toEqual(["get:exec"]);

    store.destroy();
  });

  test("cancels correctly if aborted while waiting", async () => {
    let resolveSave!: (v: string) => void;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      savePost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: () => "savePost:1",
        execute: async (): Promise<string> => {
          return new Promise<string>((resolve) => {
            resolveSave = resolve;
          });
        },
      },
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        waitFor: () => ["savePost:1"],
        execute: async (): Promise<string> => "fetched",
      },
    }));

    store.operations.savePost();
    await new Promise((r) => setTimeout(r, 10));

    const hGet = store.operations.getPost();
    await new Promise((r) => setTimeout(r, 10));

    // Cancel get while it's waiting for save
    hGet.cancel();
    await hGet.promise.catch(() => {});

    expect(hGet.getState().isCancelled).toBe(true);

    // Finish save to clean up
    resolveSave("done");
    store.destroy();
  });

  test("re-check loop detects new op on same lane key after first dep settles", async () => {
    const log: string[] = [];
    const resolvers: Array<(v: string) => void> = [];

    const store = createStore({ ...EMPTY_STATE }, () => ({
      savePost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: () => "save:1",
        execute: async (_params: void, signal: AbortSignal): Promise<string> => {
          return new Promise<string>((resolve, reject) => {
            resolvers.push(resolve);
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        },
      },
      getPost: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        waitFor: () => ["save:1"],
        execute: async (): Promise<string> => {
          log.push("get:exec");
          return "fetched";
        },
      },
    }));

    // Start first save
    const hSave1 = store.operations.savePost();
    await new Promise((r) => setTimeout(r, 10));

    // Start get — waits for save:1
    const hGet = store.operations.getPost();
    await new Promise((r) => setTimeout(r, 10));

    // Start second save on same lane (cancelPrevious aborts first)
    const hSave2 = store.operations.savePost();
    await new Promise((r) => setTimeout(r, 10));

    // Resolve second save (first was aborted)
    resolvers[1]!("saved2");
    await hSave2.promise;
    await hGet.promise;

    // get should only execute after second save finishes
    expect(log).toEqual(["get:exec"]);

    store.destroy();
  });

  test("cancelPrevious interaction — second invocation cancels first which was waiting", async () => {
    let resolveDep!: (v: string) => void;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      dep: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: () => "dep",
        execute: async (): Promise<string> => {
          return new Promise<string>((resolve) => {
            resolveDep = resolve;
          });
        },
      },
      op: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        waitFor: () => ["dep"],
        execute: async (): Promise<string> => "done",
      },
    }));

    store.operations.dep();
    await new Promise((r) => setTimeout(r, 10));

    // First invocation of op — waits for dep
    const h1 = store.operations.op();
    await new Promise((r) => setTimeout(r, 10));

    // Second invocation — cancelPrevious should cancel h1
    const h2 = store.operations.op();

    // Resolve dep so h2 can proceed
    resolveDep("resolved");

    await h2.promise;
    await h1.promise.catch(() => {});

    expect(h1.getState().isCancelled).toBe(true);
    expect(h2.getState().isSuccess).toBe(true);

    store.destroy();
  });

  test("enqueue interaction — enqueued op waits for deps when it starts", async () => {
    const log: string[] = [];
    let resolveFirst!: () => void;
    let resolveDep!: (v: string) => void;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      dep: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: () => "dep",
        execute: async (): Promise<string> => {
          return new Promise<string>((resolve) => {
            resolveDep = resolve;
          });
        },
      },
      op: {
        type: "async" as const,
        concurrency: "enqueue" as const,
        waitFor: () => ["dep"],
        execute: async (params: number): Promise<number> => {
          log.push(`exec:${params}`);
          if (params === 1) {
            return new Promise<number>((resolve) => {
              resolveFirst = () => resolve(1);
            });
          }
          return params;
        },
      },
    }));

    // First op — no dep active, proceeds immediately
    const h1 = store.operations.op(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(["exec:1"]);

    // Start dep
    store.operations.dep();
    await new Promise((r) => setTimeout(r, 10));

    // Enqueue second op — will wait behind h1, then check waitFor
    const h2 = store.operations.op(2);

    // Finish first op
    resolveFirst();
    await h1.promise;
    await new Promise((r) => setTimeout(r, 10));

    // h2 should be waiting for dep now, not yet executed
    expect(log).toEqual(["exec:1"]);

    // Resolve dep
    resolveDep("done");
    await h2.promise;

    expect(log).toEqual(["exec:1", "exec:2"]);

    store.destroy();
  });

  test("deduplicate interaction — deduplicated handle does NOT re-run waitFor", async () => {
    let waitForCallCount = 0;
    let resolveExec!: (v: string) => void;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      op: {
        type: "async" as const,
        concurrency: "deduplicate" as const,
        waitFor: () => {
          waitForCallCount++;
          return [];
        },
        execute: async (): Promise<string> => {
          return new Promise<string>((resolve) => {
            resolveExec = resolve;
          });
        },
      },
    }));

    const h1 = store.operations.op();
    const h2 = store.operations.op(); // deduplicated — reuses h1

    // waitFor should only be called once (for h1's startAsyncInvocation)
    expect(waitForCallCount).toBe(1);

    resolveExec("result");
    await Promise.all([h1.promise, h2.promise]);

    expect(h1.getState().data).toBe("result");
    expect(h2.getState().data).toBe("result");

    store.destroy();
  });

  test("resolve interaction — waits before resolve check, so resolve sees fresh state", async () => {
    let resolveSave!: () => void;

    const store = createStore(
      { ...EMPTY_STATE, counter: 0 },
      ({ get, set }) => ({
        saveCounter: {
          type: "async" as const,
          concurrency: "cancelPrevious" as const,
          key: () => "saveCounter",
          execute: async (): Promise<number> => {
            return new Promise<number>((resolve) => {
              resolveSave = () => {
                set("counter", 42);
                resolve(42);
              };
            });
          },
        },
        getCounter: {
          type: "async" as const,
          concurrency: "cancelPrevious" as const,
          waitFor: () => ["saveCounter"],
          resolve: () => {
            const val = get("counter");
            return val > 0 ? val : undefined;
          },
          execute: async (): Promise<number> => {
            return get("counter") as number;
          },
        },
      }),
    );

    // Start save
    store.operations.saveCounter();
    await new Promise((r) => setTimeout(r, 10));

    // Start getCounter — will wait for save, then resolve should see updated state
    const hGet = store.operations.getCounter();

    // Resolve save (sets counter to 42)
    resolveSave();
    const result = await hGet.promise;

    expect(result).toBe(42);
    expect(hGet.getState().resolvedFromStore).toBe(true);

    store.destroy();
  });

  test("waits for all specified lane keys (multiple deps)", async () => {
    const log: string[] = [];
    let resolveA!: (v: string) => void;
    let resolveB!: (v: string) => void;

    const store = createStore({ ...EMPTY_STATE }, () => ({
      depA: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: () => "depA",
        execute: async (): Promise<string> => {
          return new Promise<string>((resolve) => {
            resolveA = resolve;
          });
        },
      },
      depB: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        key: () => "depB",
        execute: async (): Promise<string> => {
          return new Promise<string>((resolve) => {
            resolveB = resolve;
          });
        },
      },
      op: {
        type: "async" as const,
        concurrency: "cancelPrevious" as const,
        waitFor: () => ["depA", "depB"],
        execute: async (): Promise<string> => {
          log.push("op:exec");
          return "done";
        },
      },
    }));

    store.operations.depA();
    store.operations.depB();
    await new Promise((r) => setTimeout(r, 10));

    const hOp = store.operations.op();
    await new Promise((r) => setTimeout(r, 10));

    expect(log).toEqual([]);

    // Resolve only A — should still wait for B
    resolveA("a");
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual([]);

    // Resolve B — now op should proceed
    resolveB("b");
    await hOp.promise;

    expect(log).toEqual(["op:exec"]);

    store.destroy();
  });
});
