import type { Todo } from "./types";

export async function fetchTodos(signal: AbortSignal): Promise<Todo[]> {
  const res = await fetch("/api/todos", { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createTodo(title: string, signal: AbortSignal): Promise<Todo> {
  const res = await fetch("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function updateTodo(
  id: number,
  patch: Partial<Pick<Todo, "title" | "completed">>,
  signal: AbortSignal,
): Promise<Todo> {
  const res = await fetch(`/api/todos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function removeTodo(id: number, signal: AbortSignal): Promise<Todo> {
  const res = await fetch(`/api/todos/${id}`, {
    method: "DELETE",
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
