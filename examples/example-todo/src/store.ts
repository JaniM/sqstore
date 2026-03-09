import { createStore } from "@sqstore/core";
import * as api from "./api";
import type { Todo } from "./types";

interface TodoState {
  todos: Todo[];
}

export function createTodoStore() {
  return createStore({ todos: [] } as TodoState, ({ operations, get, set, update }) => ({
    // ---------------------------------------------------------------
    // fetchTodos — deduplicate: multiple calls share one in-flight request
    // ---------------------------------------------------------------
    fetchTodos: {
      type: "async" as const,
      concurrency: "deduplicate" as const,

      execute: async (_params, signal) => {
        return api.fetchTodos(signal);
      },

      onSuccess: (todos) => {
        set("todos", todos);
      },
    },

    // ---------------------------------------------------------------
    // addTodo — enqueue: rapid adds are queued sequentially
    // ---------------------------------------------------------------
    addTodo: {
      type: "async" as const,
      concurrency: "enqueue" as const,

      execute: async (params: Pick<Todo, "title">, signal) => {
        return api.createTodo(params.title, signal);
      },

      onSuccess: (todo: Todo) => {
        update("todos", (todos) => [...todos, todo]);
      },
    },

    // ---------------------------------------------------------------
    // toggleTodo — cancelPrevious per entity: rapid toggles on same
    // todo cancel the previous request
    // ---------------------------------------------------------------
    toggleTodo: {
      type: "async" as const,
      concurrency: "cancelPrevious" as const,
      key: (params: { id: number }) => `toggletodo:${params.id}`,

      execute: async (params: { id: number }, signal) => {
        const current = get("todos").find((t) => t.id === params.id);
        return api.updateTodo(params.id, { completed: !current?.completed }, signal);
      },

      onSuccess: (updated: Todo) => {
        update("todos", (todos) => todos.map((t) => (t.id === updated.id ? updated : t)));
      },
    },

    // ---------------------------------------------------------------
    // deleteTodo — deduplicate per entity
    // ---------------------------------------------------------------
    deleteTodo: {
      type: "async" as const,
      concurrency: "deduplicate" as const,
      key: (params: { id: number }) => `deletetodo:${params.id}`,

      execute: async (params: { id: number }, signal) => {
        return api.removeTodo(params.id, signal);
      },

      onSuccess: (_removed: Todo, params: { id: number }) => {
        update("todos", (todos) => todos.filter((t) => t.id !== params.id));
      },
    },

    // ---------------------------------------------------------------
    // clearCompleted
    // ---------------------------------------------------------------
    clearCompleted: {
      type: "async" as const,
      concurrency: "enqueue" as const,

      execute: async (_params: void) => {
        await Promise.all(
          get("todos")
            .filter((t) => t.completed)
            .map((t) => operations.deleteTodo({ id: t.id })),
        );
      },
    },
  }));
}

export type TodoStore = ReturnType<typeof createTodoStore>;
