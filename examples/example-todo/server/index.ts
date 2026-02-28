import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

let nextId = 4;
const todos: Todo[] = [
  { id: 1, title: "Learn @next-gen-store/core", completed: true },
  { id: 2, title: "Build a Vue app with useSlot & useOperation", completed: false },
  { id: 3, title: "Try concurrency strategies", completed: false },
];

const DELAY = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse) {
  json(res, 404, { error: "Not found" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method?.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  await delay(DELAY);

  // GET /api/todos
  if (path === "/api/todos" && method === "GET") {
    json(res, 200, todos);
    return;
  }

  // POST /api/todos
  if (path === "/api/todos" && method === "POST") {
    const body = JSON.parse(await readBody(req));
    const todo: Todo = {
      id: nextId++,
      title: body.title,
      completed: false,
    };
    todos.push(todo);
    json(res, 201, todo);
    return;
  }

  // PATCH /api/todos/:id
  const patchMatch = path.match(/^\/api\/todos\/(\d+)$/);
  if (patchMatch && method === "PATCH") {
    const id = Number(patchMatch[1]);
    const todo = todos.find((t) => t.id === id);
    if (!todo) return notFound(res);
    const body = JSON.parse(await readBody(req));
    if (body.title !== undefined) todo.title = body.title;
    if (body.completed !== undefined) todo.completed = body.completed;
    json(res, 200, todo);
    return;
  }

  // DELETE /api/todos/:id
  const deleteMatch = path.match(/^\/api\/todos\/(\d+)$/);
  if (deleteMatch && method === "DELETE") {
    const id = Number(deleteMatch[1]);
    const idx = todos.findIndex((t) => t.id === id);
    if (idx === -1) return notFound(res);
    const [removed] = todos.splice(idx, 1);
    json(res, 200, removed);
    return;
  }

  notFound(res);
});

server.listen(3001, () => {
  console.log("API server running on http://localhost:3001");
});
