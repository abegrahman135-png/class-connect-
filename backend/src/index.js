const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "audio/webm",
  "audio/ogg"
]);

const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, message);
}

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra
    }
  });
}

function errorResponse(error) {
  if (!(error instanceof HttpError)) {
    console.error("Request failed", error?.stack || error);
  }

  return json(
    {
      error:
        error instanceof HttpError
          ? error.message
          : "Server error. Please retry."
    },
    error instanceof HttpError ? error.status : 500
  );
}

export function cleanText(value, min, max, label) {
  if (typeof value !== "string") fail(400, `${label} is required.`);

  const result = value.trim();

  if (result.length < min || result.length > max) {
    fail(400, `${label} must contain ${min}–${max} characters.`);
  }

  return result;
}

export function normalizeInvite(value) {
  return cleanText(value, 8, 100, "Invite code")
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

export function allowedMime(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();

  if (!ALLOWED_MIME.has(mime)) {
    fail(400, "Supported files: JPEG, PNG, WebP, PDF, WebM audio or Ogg audio.");
  }

  return mime;
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function boundedBytes(request, limit) {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      length += value.byteLength;

      if (length > limit) {
        await reader.cancel();
        fail(413, "Request is too large.");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

async function bodyJSON(request, limit = 8192) {
  try {
    const bytes = await boundedBytes(request, limit);
    const value = JSON.parse(new TextDecoder().decode(bytes));

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(400, "Expected a JSON object.");
    }

    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "Invalid JSON.");
  }
}

function cookieName(env) {
  return env.APP_ORIGIN.startsWith("https:")
    ? "__Host-classconnect"
    : "classconnect-dev";
}

function sessionCookie(env, token, maxAge = SESSION_SECONDS) {
  const secure = env.APP_ORIGIN.startsWith("https:") ? "; Secure" : "";

  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function getCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;

    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }

  return "";
}

async function authenticate(request, env) {
  const token = getCookie(request, cookieName(env));

  if (!/^[a-f0-9]{64}$/.test(token)) fail(401, "Please sign in.");

  const tokenHash = await hash(token);

  const user = await env.DB.prepare(`
    SELECT u.id, u.display_name, u.role, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, Date.now()).first();

  if (!user) fail(401, "Your session has expired. Please sign in.");

  return { ...user, session_hash: tokenHash };
}

async function createSession(env, userId) {
  const token = randomToken();
  const expires = Date.now() + SESSION_SECONDS * 1000;

  await env.DB.prepare(`
    INSERT INTO sessions(token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(await hash(token), userId, expires).run();

  return sessionCookie(env, token);
}

function publicUser(user) {
  return {
    id: user.id,
    display_name: user.display_name,
    role: user.role
  };
}

function verifyOrigin(request, env) {
  const url = new URL(request.url);

  if (url.origin !== env.APP_ORIGIN) {
    fail(403, "Unrecognized application origin.");
  }

  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const websocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

  if (
    (unsafe || websocket) &&
    request.headers.get("Origin") !== env.APP_ORIGIN
  ) {
    fail(403, "Origin verification failed.");
  }
}

async function membership(env, classId, userId) {
  return env.DB.prepare(`
    SELECT m.*, c.teacher_id, c.name
    FROM class_members m
    JOIN classes c ON c.id = m.class_id
    WHERE m.class_id = ? AND m.user_id = ?
  `).bind(classId, userId).first();
}

async function consume(env, key, limit, seconds, amount = 1) {
  const stub = env.GUARD.get(env.GUARD.idFromName("global"));

  const response = await stub.fetch("https://internal/consume", {
    method: "POST",
    body: JSON.stringify({ key, limit, seconds, amount })
  });

  if (!response.ok) {
    fail(429, "Application quota reached. Please try again later.");
  }
}

async function ipLimit(request, env, category, limit, seconds) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const identity = (await hash(ip)).slice(0, 24);

  await consume(env, `ip:${category}:${identity}`, limit, seconds);
}

async function roomRequest(request, env, classId) {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(classId));
  return stub.fetch(request);
}

function attachmentInfo(row) {
  if (!row.attachment_id || !row.file_name) return null;

  return {
    id: row.attachment_id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes
  };
}

function messageJSON(row) {
  return {
    seq: row.seq,
    id: row.id,
    class_id: row.class_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    client_id: row.client_id,
    content: row.deleted ? "" : row.content,
    created_at: row.created_at,
    deleted: Boolean(row.deleted),
    attachment: row.deleted ? null : attachmentInfo(row)
  };
}

const MESSAGE_SELECT = `
  SELECT m.*, u.display_name AS sender_name,
    a.file_name, a.mime_type, a.size_bytes
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN attachments a ON a.id = m.attachment_id
`;

async function loadMessage(env, id) {
  const row = await env.DB.prepare(
    `${MESSAGE_SELECT} WHERE m.id = ?`
  ).bind(id).first();

  return row ? messageJSON(row) : null;
}

function sniffFile(bytes, mime) {
  const ascii = (start, length) =>
    String.fromCharCode(...bytes.slice(start, start + length));

  const valid =
    (mime === "image/jpeg" &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (mime === "image/png" &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) ||
    (mime === "image/webp" &&
      ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") ||
    (mime === "application/pdf" && ascii(0, 5) === "%PDF-") ||
    (mime === "audio/ogg" && ascii(0, 4) === "OggS") ||
    (mime === "audio/webm" &&
      [0x1a, 0x45, 0xdf, 0xa3].every((b, i) => bytes[i] === b));

  if (!valid) fail(400, "File contents do not match its declared format.");
}

async function upload(request, env, user) {
  const url = new URL(request.url);
  const classId = cleanText(url.searchParams.get("class"), 1, 100, "Class");
  const fileName = cleanText(url.searchParams.get("name"), 1, 160, "File name");
  const size = Number(url.searchParams.get("size"));
  const mime = allowedMime(request.headers.get("Content-Type"));

  if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
    fail(413, "Files must be between 1 byte and 5 MiB.");
  }

  const member = await membership(env, classId, user.id);
  if (!member || member.muted) fail(403, "You cannot upload to this class.");

  // Reservations are not refunded on failure. This is intentionally conservative.
  await consume(env, `upload-count:${user.id}`, 10, 86400);
  await consume(env, `upload-bytes:${user.id}`, 20 * 1024 * 1024, 86400, size);
  await consume(env, "upload-global-day", 50 * 1024 * 1024, 86400, size);
  await consume(env, "upload-lifetime", 512 * 1024 * 1024, 0, size);

  const bytes = await boundedBytes(request, MAX_FILE_BYTES);
  if (bytes.byteLength !== size) fail(400, "Upload size mismatch.");

  sniffFile(bytes, mime);

  // Recheck after reading the body in case moderation changed while uploading.
  const current = await membership(env, classId, user.id);
  if (!current || current.muted) fail(403, "Upload permission was revoked.");

  const id = crypto.randomUUID();
  const key = `${classId}/${id}`;

  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: mime }
  });

  try {
    await env.DB.prepare(`
      INSERT INTO attachments
        (id, class_id, owner_id, r2_key, file_name, mime_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, classId, user.id, key, fileName, mime, size, Date.now()
    ).run();
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }

  return json({ id, file_name: fileName, mime_type: mime, size_bytes: size }, 201);
}

async function download(request, env, user, attachmentId) {
  await consume(env, `downloads:${user.id}`, 120, 3600);

  const row = await env.DB.prepare(`
    SELECT a.*
    FROM attachments a
    JOIN messages m ON m.attachment_id = a.id AND m.deleted = 0
    JOIN class_members cm ON cm.class_id = a.class_id AND cm.user_id = ?
    WHERE a.id = ?
  `).bind(user.id, attachmentId).first();

  if (!row) fail(404, "Attachment is unavailable.");

  const object = await env.FILES.get(row.r2_key);
  if (!object) fail(404, "Attachment has expired.");

  const fileName = encodeURIComponent(row.file_name).replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${fileName}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox"
    }
  });
}

async function handle(request, env) {
  verifyOrigin(request, env);

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      features: { push: false, calls: false, directMessages: false }
    });
  }

  if (path === "/api/auth/login" && method === "POST") {
    await ipLimit(request, env, "login", 20, 3600);

    const body = await bodyJSON(request);
    const key = cleanText(body.key, 64, 64, "Recovery key").toLowerCase();

    if (!/^[a-f0-9]{64}$/.test(key)) fail(401, "Invalid recovery key.");

    const user = await env.DB.prepare(`
      SELECT id, display_name, role FROM users WHERE recovery_hash = ?
    `).bind(await hash(key)).first();

    if (!user) fail(401, "Invalid recovery key.");

    return json(
      { user: publicUser(user) },
      200,
      { "Set-Cookie": await createSession(env, user.id) }
    );
  }

  if (path === "/api/auth/join" && method === "POST") {
    await ipLimit(request, env, "join", 10, 3600);
    await consume(env, "enrollments-global", 100, 86400);

    const body = await bodyJSON(request);
    const displayName = cleanText(body.name, 1, 60, "Name");
    const inviteHash = await hash(normalizeInvite(body.code));

    const classroom = await env.DB.prepare(`
      SELECT id FROM classes WHERE join_hash = ?
    `).bind(inviteHash).first();

    if (!classroom) fail(400, "Invalid invitation code.");

    const userId = crypto.randomUUID();
    const recoveryKey = randomToken();

    // Guarded INSERT prevents enrollment if the code was rotated meanwhile
    // or the class has reached its member cap.
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO users(id, display_name, role, recovery_hash, created_at)
        SELECT ?, ?, 'student', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM classes c
          WHERE c.id = ? AND c.join_hash = ?
          AND (SELECT COUNT(*) FROM class_members WHERE class_id = c.id) < 41
        )
      `).bind(
        userId, displayName, await hash(recoveryKey), Date.now(),
        classroom.id, inviteHash
      ),
      env.DB.prepare(`
        INSERT INTO class_members(class_id, user_id, joined_at)
        SELECT ?, id, ? FROM users WHERE id = ?
      `).bind(classroom.id, Date.now(), userId)
    ]);

    if (!results[0].meta.changes) {
      fail(409, "Invitation changed or the class is full.");
    }

    return json(
      {
        user: { id: userId, display_name: displayName, role: "student" },
        recoveryKey
      },
      201,
      { "Set-Cookie": await createSession(env, userId) }
    );
  }

  const user = await authenticate(request, env);

  if (path === "/api/auth/logout" && method === "POST") {
    await env.DB.prepare(
      "DELETE FROM sessions WHERE token_hash = ?"
    ).bind(user.session_hash).run();

    return json(
      { ok: true },
      200,
      { "Set-Cookie": sessionCookie(env, "", 0) }
    );
  }

  if (path === "/api/me" && method === "GET") {
    return json({ user: publicUser(user) });
  }

  if (path === "/api/classes" && method === "GET") {
    const result = await env.DB.prepare(`
      SELECT c.id, c.name, c.teacher_id, cm.muted, cm.last_read_seq
      FROM classes c
      JOIN class_members cm ON cm.class_id = c.id
      WHERE cm.user_id = ?
      ORDER BY c.created_at
    `).bind(user.id).all();

    return json({ classes: result.results });
  }

  if (path === "/api/classes" && method === "POST") {
    if (user.role !== "teacher") fail(403, "Only teachers can create classes.");

    await consume(env, `class-create:${user.id}`, 10, 86400);

    const body = await bodyJSON(request);
    const name = cleanText(body.name, 1, 80, "Class name");
    const classId = crypto.randomUUID();
    const code = randomToken(10).toUpperCase();

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO classes(id, name, teacher_id, join_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(classId, name, user.id, await hash(code), Date.now()),
      env.DB.prepare(`
        INSERT INTO class_members(class_id, user_id, joined_at)
        VALUES (?, ?, ?)
      `).bind(classId, user.id, Date.now())
    ]);

    return json({ id: classId, name, code }, 201);
  }

  if (path === "/api/classes/join" && method === "POST") {
    await consume(env, `join-existing:${user.id}`, 10, 3600);

    const body = await bodyJSON(request);
    const codeHash = await hash(normalizeInvite(body.code));

    const classroom = await env.DB.prepare(
      "SELECT id FROM classes WHERE join_hash = ?"
    ).bind(codeHash).first();

    if (!classroom) fail(400, "Invalid invitation code.");

    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO class_members(class_id, user_id, joined_at)
      SELECT c.id, ?, ? FROM classes c
      WHERE c.id = ? AND c.join_hash = ?
      AND NOT EXISTS (
        SELECT 1 FROM removed_members WHERE class_id = c.id AND user_id = ?
      )
      AND (SELECT COUNT(*) FROM class_members WHERE class_id = c.id) < 41
    `).bind(user.id, Date.now(), classroom.id, codeHash, user.id).run();

    if (!result.meta.changes && !(await membership(env, classroom.id, user.id))) {
      fail(403, "You cannot join this class.");
    }

    return json({ id: classroom.id });
  }

  const ws = path.match(/^\/ws\/classes\/([a-f0-9-]+)$/);
  if (ws && method === "GET") {
    await consume(env, `connect:${user.id}`, 60, 3600);
    return roomRequest(request, env, ws[1]);
  }

  const room = path.match(
    /^\/api\/classes\/([a-f0-9-]+)\/(roster|invite|members|messages)(?:\/([a-f0-9-]+))?$/
  );

  if (room) {
    await consume(env, `room-api:${user.id}`, 240, 3600);
    return roomRequest(request, env, room[1]);
  }

  if (path === "/api/uploads" && method === "POST") {
    return upload(request, env, user);
  }

  const file = path.match(/^\/api\/files\/([a-f0-9-]+)$/);
  if (file && method === "GET") {
    return download(request, env, user, file[1]);
  }

  fail(404, "Not found.");
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  }
};

async function cleanup(env) {
  const day = 86400000;
  const now = Date.now();

  // At most 100 object removals per run.
  const stale = await env.DB.prepare(`
    SELECT a.id, a.r2_key
    FROM attachments a
    WHERE a.created_at < ?
       OR (
         a.created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE m.attachment_id = a.id AND m.deleted = 0
         )
       )
    ORDER BY a.created_at
    LIMIT 100
  `).bind(now - 30 * day, now - day).all();

  for (const item of stale.results) {
    await env.FILES.delete(item.r2_key);
    await env.DB.prepare("DELETE FROM attachments WHERE id = ?")
      .bind(item.id).run();
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM messages WHERE created_at < ?")
      .bind(now - 30 * day)
  ]);
}

/**
 * Private, SQLite-backed quota coordinator.
 * Persistent counters survive Durable Object hibernation/restarts.
 */
export class BudgetGuard {
  constructor(ctx) {
    this.ctx = ctx;

    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        key TEXT PRIMARY KEY,
        used INTEGER NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS counters_expiry ON counters(expires);
    `);
  }

  async fetch(request) {
    const { key, limit, seconds, amount } = await request.json();
    const sql = this.ctx.storage.sql;
    const now = Date.now();

    sql.exec("DELETE FROM counters WHERE expires > 0 AND expires <= ?", now);

    const row = [...sql.exec(
      "SELECT used FROM counters WHERE key = ?", key
    )][0];

    if ((row?.used || 0) + amount > limit) {
      return new Response("Quota exceeded", { status: 429 });
    }

    sql.exec(`
      INSERT INTO counters(key, used, expires) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET used = used + excluded.used
    `, key, amount, seconds ? now + seconds * 1000 : 0);

    return new Response("OK");
  }
}

/**
 * One SQLite-backed, hibernating Durable Object per class.
 */
export class ClassRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();

    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        user_id TEXT PRIMARY KEY,
        started INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
    `);
  }

  serial(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  send(socket, value) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      try { socket.close(1011, "Connection error"); } catch {}
    }
  }

  broadcast(value) {
    for (const socket of this.ctx.getWebSockets()) {
      this.send(socket, value);
    }
  }

  presence() {
    const users = new Set();

    for (const socket of this.ctx.getWebSockets()) {
      const auth = socket.deserializeAttachment();
      if (auth?.expires_at > Date.now()) users.add(auth.id);
    }

    this.broadcast({ type: "presence", userIds: [...users] });
  }

  rateLimit(userId) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const row = [...sql.exec(
      "SELECT started, count FROM rate_limits WHERE user_id = ?", userId
    )][0];

    if (!row || now - row.started >= 60000) {
      sql.exec(`
        INSERT INTO rate_limits(user_id, started, count) VALUES (?, ?, 1)
        ON CONFLICT(user_id) DO UPDATE SET started = excluded.started, count = 1
      `, userId, now);
      return;
    }

    if (row.count >= 90) fail(429, "Too many events. Wait a minute.");
    sql.exec("UPDATE rate_limits SET count = count + 1 WHERE user_id = ?", userId);
  }

  async fetch(request) {
    try {
      return await this.serial(() => this.route(request));
    } catch (error) {
      return errorResponse(error);
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const user = await authenticate(request, this.env);
    const match = url.pathname.match(/\/classes\/([a-f0-9-]+)/);
    const classId = match?.[1];

    const member = await membership(this.env, classId, user.id);
    if (!member) fail(403, "You are not a member of this class.");

    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        fail(426, "WebSocket required.");
      }

      const sockets = this.ctx.getWebSockets();
      if (sockets.length >= 82) fail(429, "Class connection limit reached.");

      const ownSockets = sockets.filter(
        socket => socket.deserializeAttachment()?.id === user.id
      );

      if (ownSockets.length >= 2) {
        ownSockets[0].close(4001, "Opened on another tab or device.");
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        id: user.id,
        display_name: user.display_name,
        session_hash: user.session_hash,
        expires_at: user.expires_at,
        classId
      });

      this.send(server, { type: "ready" });
      this.presence();

      return new Response(null, { status: 101, webSocket: client });
    }

    const suffix = url.pathname.split(`/classes/${classId}/`)[1];
    const [resource, targetId] = suffix.split("/");
    const method = request.method;

    if (resource === "roster" && method === "GET") {
      const result = await this.env.DB.prepare(`
        SELECT u.id, u.display_name, u.role, cm.muted, cm.last_read_seq
        FROM class_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.class_id = ?
        ORDER BY u.role DESC, u.display_name
      `).bind(classId).all();

      return json({ members: result.results });
    }

    if (resource === "messages" && method === "GET") {
      const afterValue = url.searchParams.get("after");
      const beforeValue = url.searchParams.get("before");
      let query;
      let args;

      if (afterValue !== null) {
        const after = Number(afterValue);
        if (!Number.isSafeInteger(after) || after < 0) fail(400, "Invalid cursor.");

        query = `${MESSAGE_SELECT}
          WHERE m.class_id = ? AND m.seq > ?
          ORDER BY m.seq ASC LIMIT 100`;
        args = [classId, after];
      } else if (beforeValue !== null) {
        const before = Number(beforeValue);
        if (!Number.isSafeInteger(before) || before < 1) fail(400, "Invalid cursor.");

        query = `${MESSAGE_SELECT}
          WHERE m.class_id = ? AND m.seq < ?
          ORDER BY m.seq DESC LIMIT 100`;
        args = [classId, before];
      } else {
        query = `${MESSAGE_SELECT}
          WHERE m.class_id = ? ORDER BY m.seq DESC LIMIT 100`;
        args = [classId];
      }

      const result = await this.env.DB.prepare(query).bind(...args).all();
      const messages = result.results.map(messageJSON);

      if (afterValue === null) messages.reverse();

      return json({ messages });
    }

    if (member.teacher_id !== user.id) {
      fail(403, "Only the class teacher can perform this action.");
    }

    if (resource === "invite" && method === "POST") {
      const code = randomToken(10).toUpperCase();

      await this.env.DB.prepare(
        "UPDATE classes SET join_hash = ? WHERE id = ?"
      ).bind(await hash(code), classId).run();

      return json({ code });
    }

    if (resource === "members" && targetId && method === "PATCH") {
      if (targetId === user.id) fail(400, "You cannot mute yourself.");

      const body = await bodyJSON(request);
      if (typeof body.muted !== "boolean") fail(400, "Invalid mute value.");

      await this.env.DB.prepare(`
        UPDATE class_members SET muted = ?
        WHERE class_id = ? AND user_id = ?
      `).bind(body.muted ? 1 : 0, classId, targetId).run();

      this.broadcast({ type: "roster:changed" });
      return json({ ok: true });
    }

    if (resource === "members" && targetId && method === "DELETE") {
      if (targetId === user.id) fail(400, "You cannot remove yourself.");

      // Removing someone rotates the shared invitation as well.
      const code = randomToken(10).toUpperCase();

      await this.env.DB.batch([
        this.env.DB.prepare(`
          INSERT OR REPLACE INTO removed_members(class_id, user_id, removed_at)
          SELECT class_id, user_id, ? FROM class_members
          WHERE class_id = ? AND user_id = ?
        `).bind(Date.now(), classId, targetId),
        this.env.DB.prepare(`
          DELETE FROM class_members WHERE class_id = ? AND user_id = ?
        `).bind(classId, targetId),
        this.env.DB.prepare("UPDATE classes SET join_hash = ? WHERE id = ?")
          .bind(await hash(code), classId)
      ]);

      for (const socket of this.ctx.getWebSockets()) {
        if (socket.deserializeAttachment()?.id === targetId) {
          socket.close(4003, "Removed from class.");
        }
      }

      this.broadcast({ type: "roster:changed" });
      this.presence();

      return json({ ok: true, code });
    }

    if (resource === "messages" && targetId && method === "DELETE") {
      await this.env.DB.prepare(`
        UPDATE messages SET deleted = 1, content = ''
        WHERE id = ? AND class_id = ?
      `).bind(targetId, classId).run();

      this.broadcast({ type: "message:deleted", id: targetId });
      return json({ ok: true });
    }

    fail(404, "Not found.");
  }

  async webSocketMessage(socket, raw) {
    return this.serial(async () => {
      let event;

      try {
        if (typeof raw !== "string" || raw.length > 8192) {
          fail(400, "Invalid message frame.");
        }

        event = JSON.parse(raw);
        if (!event || typeof event !== "object") fail(400, "Invalid event.");

        const auth = socket.deserializeAttachment();
        if (!auth || auth.expires_at <= Date.now()) {
          socket.close(4001, "Session expired.");
          return;
        }

        this.rateLimit(auth.id);

        if (event.type === "typing") {
          this.broadcast({
            type: "typing",
            userId: auth.id,
            name: auth.display_name
          });
          return;
        }

        // Persistent operations always revalidate both session and membership.
        const validSession = await this.env.DB.prepare(`
          SELECT 1 FROM sessions
          WHERE token_hash = ? AND user_id = ? AND expires_at > ?
        `).bind(auth.session_hash, auth.id, Date.now()).first();

        if (!validSession) {
          socket.close(4001, "Session expired.");
          return;
        }

        const member = await membership(this.env, auth.classId, auth.id);
        if (!member) {
          socket.close(4003, "Class access revoked.");
          return;
        }

        if (event.type === "message:new") {
          if (member.muted) fail(403, "You are muted in this class.");

          const clientId = cleanText(event.clientId, 1, 100, "Client ID");
          const content = cleanText(event.content ?? "", 0, 4000, "Message");
          const attachmentId = event.attachmentId || null;

          const existing = await this.env.DB.prepare(`
            SELECT id FROM messages
            WHERE class_id = ? AND sender_id = ? AND client_id = ?
          `).bind(auth.classId, auth.id, clientId).first();

          if (existing) {
            this.send(socket, {
              type: "message:ack",
              clientId,
              message: await loadMessage(this.env, existing.id)
            });
            return;
          }

          if (!content && !attachmentId) fail(400, "Write a message or attach a file.");

          if (attachmentId) {
            const attachment = await this.env.DB.prepare(`
              SELECT id FROM attachments
              WHERE id = ? AND class_id = ? AND owner_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM messages WHERE attachment_id = attachments.id
              )
            `).bind(attachmentId, auth.classId, auth.id).first();

            if (!attachment) fail(400, "Attachment is unavailable or already used.");
          }

          const id = crypto.randomUUID();

          // Persistence happens BEFORE acknowledgement or broadcast.
          await this.env.DB.prepare(`
            INSERT INTO messages
              (id, class_id, sender_id, client_id, content, attachment_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            id, auth.classId, auth.id, clientId, content, attachmentId, Date.now()
          ).run();

          const message = await loadMessage(this.env, id);

          this.send(socket, { type: "message:ack", clientId, message });
          this.broadcast({ type: "message:new", message });
          return;
        }

        if (event.type === "message:read") {
          const seq = Number(event.seq);
          if (!Number.isSafeInteger(seq) || seq < 1) fail(400, "Invalid read cursor.");

          const exists = await this.env.DB.prepare(`
            SELECT 1 FROM messages WHERE class_id = ? AND seq = ?
          `).bind(auth.classId, seq).first();

          if (!exists) fail(400, "Unknown message.");

          await this.env.DB.prepare(`
            UPDATE class_members
            SET last_read_seq = MAX(last_read_seq, ?)
            WHERE class_id = ? AND user_id = ?
          `).bind(seq, auth.classId, auth.id).run();

          this.broadcast({
            type: "message:read",
            userId: auth.id,
            seq: Math.max(seq, member.last_read_seq)
          });
          return;
        }

        fail(400, "Unsupported event.");
      } catch (error) {
        if (!(error instanceof HttpError)) console.error(error);

        this.send(socket, {
          type: "error",
          clientId: event?.clientId,
          code: error instanceof HttpError ? error.status : 500,
          message:
            error instanceof HttpError ? error.message : "Could not save message."
        });
      }
    });
  }

  async webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch {}
    this.presence();
  }

  async webSocketError(socket) {
    try { socket.close(1011, "Connection error"); } catch {}
    this.presence();
  }
}
