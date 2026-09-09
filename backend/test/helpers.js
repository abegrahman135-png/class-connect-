import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { ClassRoom } from "../src/index.js";

export const ORIGIN = "http://localhost";
export const COOKIE_NAME = "classconnect-dev";

const MIGRATION = readFileSync(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8"
);

/** Minimal `ctx.storage.sql` shim over node:sqlite for Durable Object classes. */
function makeSql(db) {
  return {
    exec(query, ...params) {
      const head = query.trim().slice(0, 6).toUpperCase();
      if (params.length === 0 && head !== "SELECT") {
        db.exec(query); // multi-statement DDL/DML without parameters
        return [];
      }
      const stmt = db.prepare(query);
      if (head === "SELECT") return stmt.all(...params);
      stmt.run(...params);
      return [];
    }
  };
}

const asNumber = value => (typeof value === "bigint" ? Number(value) : value);

/** D1-compatible shim (`prepare`/`bind`/`first`/`all`/`run`/`batch`) over node:sqlite. */
function makeD1(db) {
  return {
    prepare(query) {
      const stmt = db.prepare(query);
      return {
        bind(...params) {
          return {
            first(column) {
              const row = stmt.get(...params) ?? null;
              if (row === null) return null;
              return column === undefined ? row : (row[column] ?? null);
            },
            all() {
              return {
                success: true,
                results: stmt.all(...params),
                meta: { rows_read: 0, rows_written: 0 }
              };
            },
            run() {
              const info = stmt.run(...params);
              return {
                success: true,
                meta: {
                  changes: asNumber(info.changes),
                  last_row_id: asNumber(info.lastInsertRowid),
                  rows_read: 0,
                  rows_written: 0
                }
              };
            }
          };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    }
  };
}

/** In-memory R2 shim. */
function makeR2() {
  const objects = new Map();
  return {
    async put(key, value, options = {}) {
      let bytes;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof Uint8Array) bytes = value.slice();
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
      else throw new Error("Unsupported R2 value type in tests");
      objects.set(key, { bytes, httpMetadata: options.httpMetadata ?? {} });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { body: object.bytes.slice(), size: object.bytes.byteLength };
    },
    async delete(key) {
      objects.delete(key);
    },
    /** Test-only introspection. */
    __keys: () => [...objects.keys()]
  };
}

export async function sha256hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a fresh worker `env` backed by an empty in-memory database.
 * Quotas are allowed by default; flip `env.__test.guard.allowed` to
 * exercise 429 paths. Room routes run through the real ClassRoom class.
 */
export function createTestEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(MIGRATION);

  const guard = { allowed: true };
  const roomDb = new DatabaseSync(":memory:");
  let env;

  const roomCtx = {
    storage: { sql: makeSql(roomDb) },
    getWebSockets: () => [],
    acceptWebSocket: () => {}
  };

  env = {
    APP_ORIGIN: ORIGIN,
    DB: makeD1(db),
    FILES: makeR2(),
    GUARD: {
      idFromName: name => name,
      get: () => ({
        fetch: async () =>
          guard.allowed
            ? new Response("OK")
            : new Response("Quota exceeded", { status: 429 })
      })
    },
    ROOMS: null, // wired below, after `env` exists
    __test: { db, guard }
  };

  const rooms = new Map();
  const room = id => {
    if (!rooms.has(id)) rooms.set(id, new ClassRoom(roomCtx, env));
    return rooms.get(id);
  };
  env.ROOMS = {
    idFromName: name => name,
    get: id => ({ fetch: request => room(String(id)).fetch(request) })
  };

  return env;
}

/** Build a Request against the test worker (sets Origin for unsafe methods). */
export function apiRequest(
  path,
  { method = "GET", body, cookie, origin = ORIGIN, headers = {} } = {}
) {
  const requestHeaders = { ...headers };
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    requestHeaders.Origin = origin;
  }
  if (cookie) requestHeaders.Cookie = cookie;

  let payload;
  if (body !== undefined) {
    if (typeof body === "string" || body instanceof Uint8Array) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      requestHeaders["Content-Type"] = "application/json";
    }
  }

  return new Request(ORIGIN + path, {
    method,
    headers: requestHeaders,
    body: payload
  });
}

export async function callWorker(env, path, options) {
  const response = await worker.fetch(apiRequest(path, options), env);
  let parsed = null;
  try {
    parsed = await response.clone().json();
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, json: parsed, response };
}

/** Extract the `name=token` Cookie header value from a Set-Cookie response. */
export function sessionCookie(response) {
  const setCookie =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()[0]
      : response.headers.get("Set-Cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

/** Seed a user row directly; returns the row plus its recovery key. */
export async function seedUser(env, { name = "Test User", role = "teacher" } = {}) {
  const id = crypto.randomUUID();
  const recoveryKey = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  env.__test.db
    .prepare(
      "INSERT INTO users(id, display_name, role, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, name, role, await sha256hex(recoveryKey), Date.now());
  return { id, name, role, recoveryKey };
}

/** Log a seeded user in through the real /api/auth/login route. */
export async function login(env, recoveryKey) {
  const result = await callWorker(env, "/api/auth/login", {
    method: "POST",
    body: { key: recoveryKey }
  });
  if (result.status !== 200) {
    throw new Error(`login failed: ${result.status} ${JSON.stringify(result.json)}`);
  }
  return { user: result.json.user, cookie: sessionCookie(result.response) };
}

/** Create a class through the real route; returns { id, name, code }. */
export async function createClass(env, cookie, name = "Physics 101") {
  const result = await callWorker(env, "/api/classes", {
    method: "POST",
    cookie,
    body: { name }
  });
  if (result.status !== 201) {
    throw new Error(
      `createClass failed: ${result.status} ${JSON.stringify(result.json)}`
    );
  }
  return result.json;
}

/** Full baseline: teacher + login + class. */
export async function setupClassroom(env) {
  const teacher = await seedUser(env, { name: "Ms. Rahman", role: "teacher" });
  const session = await login(env, teacher.recoveryKey);
  const classroom = await createClass(env, session.cookie);
  return { teacher, cookie: session.cookie, classroom };
}

/** Enroll a student through the real /api/auth/join route. */
export async function joinClass(env, code, name = "Arif") {
  const result = await callWorker(env, "/api/auth/join", {
    method: "POST",
    body: { name, code }
  });
  if (result.status !== 201) {
    throw new Error(`joinClass failed: ${result.status} ${JSON.stringify(result.json)}`);
  }
  return { user: result.json.user, cookie: sessionCookie(result.response) };
}
