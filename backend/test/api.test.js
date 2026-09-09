import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  ORIGIN,
  COOKIE_NAME,
  callWorker,
  createClass,
  createTestEnv,
  joinClass,
  login,
  seedUser,
  sessionCookie,
  setupClassroom,
  sha256hex
} from "./helpers.js";

// WebSocket upgrade paths (/ws/...) need the Workers runtime's WebSocketPair
// and are intentionally not covered here; every HTTP route is.

const pngBytes = () =>
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1, 2, 3, 4]);

test("GET /api/health reports status and fixed feature flags", async () => {
  const env = createTestEnv();
  const result = await callWorker(env, "/api/health");

  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    ok: true,
    features: { push: false, calls: false, directMessages: false }
  });
});

test("requests from an unrecognized origin are rejected", async () => {
  const env = createTestEnv();

  const wrongHost = await worker.fetch(
    new Request("http://evil.example/api/health"),
    env
  );
  assert.equal(wrongHost.status, 403);

  const missingOrigin = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "x".repeat(64) })
    }),
    env
  );
  assert.equal(missingOrigin.status, 403);
});

test("login validates the recovery key before touching the database", async () => {
  const env = createTestEnv();

  const missing = await callWorker(env, "/api/auth/login", {
    method: "POST",
    body: {}
  });
  assert.equal(missing.status, 400);

  const malformed = await callWorker(env, "/api/auth/login", {
    method: "POST",
    body: { key: "not-a-key" }
  });
  assert.equal(malformed.status, 400);

  const unknown = await callWorker(env, "/api/auth/login", {
    method: "POST",
    body: { key: "a".repeat(64) }
  });
  assert.equal(unknown.status, 401);
});

test("teacher login issues a session cookie usable for /api/me", async () => {
  const env = createTestEnv();
  const teacher = await seedUser(env, { name: "Ms. Rahman", role: "teacher" });

  const result = await callWorker(env, "/api/auth/login", {
    method: "POST",
    body: { key: teacher.recoveryKey }
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.json.user, {
    id: teacher.id,
    display_name: "Ms. Rahman",
    role: "teacher"
  });

  const cookie = sessionCookie(result.response);
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));

  const me = await callWorker(env, "/api/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, teacher.id);
});

test("authenticated routes reject missing, malformed and unknown sessions", async () => {
  const env = createTestEnv();

  const missing = await callWorker(env, "/api/me");
  assert.equal(missing.status, 401);

  const malformed = await callWorker(env, "/api/me", {
    cookie: `${COOKIE_NAME}=not-a-token`
  });
  assert.equal(malformed.status, 401);

  const unknown = await callWorker(env, "/api/me", {
    cookie: `${COOKIE_NAME}=${"b".repeat(64)}`
  });
  assert.equal(unknown.status, 401);
});

test("logout destroys the session server-side", async () => {
  const env = createTestEnv();
  const { cookie } = await setupClassroom(env);

  const logout = await callWorker(env, "/api/auth/logout", {
    method: "POST",
    cookie
  });
  assert.equal(logout.status, 200);

  const me = await callWorker(env, "/api/me", { cookie });
  assert.equal(me.status, 401);
});

test("teachers can create classes and list them; students cannot create", async () => {
  const env = createTestEnv();
  const { cookie, classroom } = await setupClassroom(env);

  assert.equal(classroom.name, "Physics 101");
  assert.match(classroom.code, /^[A-F0-9]{20}$/);

  const list = await callWorker(env, "/api/classes", { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.classes.length, 1);
  assert.equal(list.json.classes[0].id, classroom.id);

  const student = await joinClass(env, classroom.code, "Arif");
  const denied = await callWorker(env, "/api/classes", {
    method: "POST",
    cookie: student.cookie,
    body: { name: "Sneaky class" }
  });
  assert.equal(denied.status, 403);
});

test("students enroll with an invitation code; bad codes are rejected", async () => {
  const env = createTestEnv();
  const { classroom } = await setupClassroom(env);

  const bad = await callWorker(env, "/api/auth/join", {
    method: "POST",
    body: { name: "Nope", code: "INVALID-CODE-1" }
  });
  assert.equal(bad.status, 400);

  // Codes are normalized (case/dashes/whitespace insensitive).
  const code = classroom.code.toLowerCase();
  const dashed = `${code.slice(0, 4)}-${code.slice(4, 8)} ${code.slice(8)}`;
  const joined = await callWorker(env, "/api/auth/join", {
    method: "POST",
    body: { name: "  Arif  ", code: dashed }
  });

  assert.equal(joined.status, 201);
  assert.equal(joined.json.user.display_name, "Arif");
  assert.equal(joined.json.user.role, "student");
  assert.match(joined.json.recoveryKey, /^[a-f0-9]{64}$/);
  assert.ok(sessionCookie(joined.response));

  // The recovery key works for later logins.
  const again = await login(env, joined.json.recoveryKey);
  assert.equal(again.user.display_name, "Arif");
});

test("existing users can join more classes with a code", async () => {
  const env = createTestEnv();
  const { cookie, classroom } = await setupClassroom(env);
  const second = await createClass(env, cookie, "Chemistry 101");

  const student = await joinClass(env, classroom.code, "Arif");
  const joined = await callWorker(env, "/api/classes/join", {
    method: "POST",
    cookie: student.cookie,
    body: { code: second.code }
  });

  assert.equal(joined.status, 200);
  assert.equal(joined.json.id, second.id);

  const list = await callWorker(env, "/api/classes", { cookie: student.cookie });
  assert.equal(list.json.classes.length, 2);

  const bad = await callWorker(env, "/api/classes/join", {
    method: "POST",
    cookie: student.cookie,
    body: { code: "INVALID-CODE-1" }
  });
  assert.equal(bad.status, 400);
});

test("uploads validate membership, size and file contents", async () => {
  const env = createTestEnv();
  const { cookie, classroom } = await setupClassroom(env);
  const outsider = await seedUser(env, { name: "Outsider", role: "student" });
  const outsiderSession = await login(env, outsider.recoveryKey);

  const upload = (bytes, cookieValue, size = bytes.byteLength, mime = "image/png") =>
    callWorker(
      env,
      `/api/uploads?class=${classroom.id}&name=photo.png&size=${size}`,
      { method: "POST", cookie: cookieValue, body: bytes, headers: { "Content-Type": mime } }
    );

  const ok = await upload(pngBytes(), cookie);
  assert.equal(ok.status, 201);
  assert.equal(ok.json.file_name, "photo.png");
  assert.equal(ok.json.mime_type, "image/png");

  const nonMember = await upload(pngBytes(), outsiderSession.cookie);
  assert.equal(nonMember.status, 403);

  const sizeMismatch = await upload(pngBytes(), cookie, 999);
  assert.equal(sizeMismatch.status, 400);

  const badMime = await upload(pngBytes(), cookie, pngBytes().byteLength, "text/html");
  assert.equal(badMime.status, 400);

  const forged = await upload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), cookie);
  assert.equal(forged.status, 400);
});

test("attachments download only for members once attached to a message", async () => {
  const env = createTestEnv();
  const { teacher, cookie, classroom } = await setupClassroom(env);

  const uploaded = await callWorker(
    env,
    `/api/uploads?class=${classroom.id}&name=photo.png&size=${pngBytes().byteLength}`,
    {
      method: "POST",
      cookie,
      body: pngBytes(),
      headers: { "Content-Type": "image/png" }
    }
  );
  const attachmentId = uploaded.json.id;

  // Orphaned uploads are not downloadable.
  const orphan = await callWorker(env, `/api/files/${attachmentId}`, { cookie });
  assert.equal(orphan.status, 404);

  const messageId = crypto.randomUUID();
  env.__test.db
    .prepare(
      "INSERT INTO messages(id, class_id, sender_id, client_id, content, attachment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(messageId, classroom.id, teacher.id, "c1", "", attachmentId, Date.now());

  const file = await callWorker(env, `/api/files/${attachmentId}`, { cookie });
  assert.equal(file.status, 200);
  assert.equal(file.response.headers.get("Content-Type"), "image/png");
  assert.match(
    file.response.headers.get("Content-Disposition"),
    /^attachment; filename\*=UTF-8''photo\.png$/
  );
  assert.deepEqual(new Uint8Array(await file.response.arrayBuffer()), pngBytes());

  const outsider = await seedUser(env, { name: "Outsider", role: "student" });
  const outsiderSession = await login(env, outsider.recoveryKey);
  const denied = await callWorker(env, `/api/files/${attachmentId}`, {
    cookie: outsiderSession.cookie
  });
  assert.equal(denied.status, 404);

  const missing = await callWorker(env, `/api/files/${crypto.randomUUID()}`, {
    cookie
  });
  assert.equal(missing.status, 404);
});

test("roster and message history are visible to members only", async () => {
  const env = createTestEnv();
  const { teacher, cookie, classroom } = await setupClassroom(env);
  const student = await joinClass(env, classroom.code, "Arif");

  const roster = await callWorker(env, `/api/classes/${classroom.id}/roster`, {
    cookie
  });
  assert.equal(roster.status, 200);
  assert.deepEqual(
    roster.json.members.map(member => member.display_name).sort(),
    ["Arif", "Ms. Rahman"]
  );

  const db = env.__test.db;
  const insert = db.prepare(
    "INSERT INTO messages(id, class_id, sender_id, client_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insert.run(crypto.randomUUID(), classroom.id, teacher.id, "t1", "Welcome", Date.now());
  insert.run(crypto.randomUUID(), classroom.id, student.user.id, "s1", "Hello", Date.now());

  const history = await callWorker(env, `/api/classes/${classroom.id}/messages`, {
    cookie: student.cookie
  });
  assert.equal(history.status, 200);
  assert.deepEqual(
    history.json.messages.map(message => message.content),
    ["Welcome", "Hello"]
  );
  assert.ok(history.json.messages[0].seq < history.json.messages[1].seq);

  const after = await callWorker(
    env,
    `/api/classes/${classroom.id}/messages?after=${history.json.messages[0].seq}`,
    { cookie }
  );
  assert.equal(after.json.messages.length, 1);
  assert.equal(after.json.messages[0].content, "Hello");

  const invalidCursor = await callWorker(
    env,
    `/api/classes/${classroom.id}/messages?after=nope`,
    { cookie }
  );
  assert.equal(invalidCursor.status, 400);

  const outsider = await seedUser(env, { name: "Outsider", role: "student" });
  const outsiderSession = await login(env, outsider.recoveryKey);
  const denied = await callWorker(env, `/api/classes/${classroom.id}/roster`, {
    cookie: outsiderSession.cookie
  });
  assert.equal(denied.status, 403);
});

test("only the class teacher can rotate invites, mute, remove and delete", async () => {
  const env = createTestEnv();
  const { cookie, classroom } = await setupClassroom(env);
  const student = await joinClass(env, classroom.code, "Arif");

  const invite = await callWorker(env, `/api/classes/${classroom.id}/invite`, {
    method: "POST",
    cookie: student.cookie,
    body: {}
  });
  assert.equal(invite.status, 403);

  const mute = await callWorker(
    env,
    `/api/classes/${classroom.id}/members/${student.user.id}`,
    { method: "PATCH", cookie: student.cookie, body: { muted: true } }
  );
  assert.equal(mute.status, 403);

  const remove = await callWorker(
    env,
    `/api/classes/${classroom.id}/members/${student.user.id}`,
    { method: "DELETE", cookie: student.cookie }
  );
  assert.equal(remove.status, 403);

  const erase = await callWorker(
    env,
    `/api/classes/${classroom.id}/messages/${crypto.randomUUID()}`,
    { method: "DELETE", cookie: student.cookie }
  );
  assert.equal(erase.status, 403);
});

test("teachers can mute and unmute students; muted students cannot upload", async () => {
  const env = createTestEnv();
  const { cookie, classroom } = await setupClassroom(env);
  const student = await joinClass(env, classroom.code, "Arif");

  const mute = await callWorker(
    env,
    `/api/classes/${classroom.id}/members/${student.user.id}`,
    { method: "PATCH", cookie, body: { muted: true } }
  );
  assert.equal(mute.status, 200);

  const roster = await callWorker(env, `/api/classes/${classroom.id}/roster`, {
    cookie
  });
  const entry = roster.json.members.find(member => member.id === student.user.id);
  assert.equal(entry.muted, 1);

  const blocked = await callWorker(
    env,
    `/api/uploads?class=${classroom.id}&name=photo.png&size=${pngBytes().byteLength}`,
    {
      method: "POST",
      cookie: student.cookie,
      body: pngBytes(),
      headers: { "Content-Type": "image/png" }
    }
  );
  assert.equal(blocked.status, 403);

  const unmute = await callWorker(
    env,
    `/api/classes/${classroom.id}/members/${student.user.id}`,
    { method: "PATCH", cookie, body: { muted: false } }
  );
  assert.equal(unmute.status, 200);

  const allowed = await callWorker(
    env,
    `/api/uploads?class=${classroom.id}&name=photo.png&size=${pngBytes().byteLength}`,
    {
      method: "POST",
      cookie: student.cookie,
      body: pngBytes(),
      headers: { "Content-Type": "image/png" }
    }
  );
  assert.equal(allowed.status, 201);
});

test("rotating the invitation invalidates the old code", async () => {
  const env = createTestEnv();
  const { cookie, classroom } = await setupClassroom(env);

  const rotated = await callWorker(env, `/api/classes/${classroom.id}/invite`, {
    method: "POST",
    cookie,
    body: {}
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.json.code, /^[A-F0-9]{20}$/);
  assert.notEqual(rotated.json.code, classroom.code);

  const stale = await callWorker(env, "/api/auth/join", {
    method: "POST",
    body: { name: "Late", code: classroom.code }
  });
  assert.equal(stale.status, 400);

  const fresh = await joinClass(env, rotated.json.code, "OnTime");
  assert.equal(fresh.user.display_name, "OnTime");
});

test("teachers can delete messages; history shows a tombstone", async () => {
  const env = createTestEnv();
  const { teacher, cookie, classroom } = await setupClassroom(env);
  const messageId = crypto.randomUUID();

  env.__test.db
    .prepare(
      "INSERT INTO messages(id, class_id, sender_id, client_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(messageId, classroom.id, teacher.id, "t1", "Oops", Date.now());

  const erased = await callWorker(
    env,
    `/api/classes/${classroom.id}/messages/${messageId}`,
    { method: "DELETE", cookie }
  );
  assert.equal(erased.status, 200);

  const history = await callWorker(env, `/api/classes/${classroom.id}/messages`, {
    cookie
  });
  assert.equal(history.json.messages.length, 1);
  assert.equal(history.json.messages[0].content, "");
  assert.equal(history.json.messages[0].deleted, true);
});

test("removing a member revokes access, rotates the code and blocks rejoin", async () => {
  const env = createTestEnv();
  const { cookie, classroom } = await setupClassroom(env);
  const student = await joinClass(env, classroom.code, "Arif");

  const removed = await callWorker(
    env,
    `/api/classes/${classroom.id}/members/${student.user.id}`,
    { method: "DELETE", cookie }
  );
  assert.equal(removed.status, 200);
  assert.match(removed.json.code, /^[A-F0-9]{20}$/);

  const roster = await callWorker(env, `/api/classes/${classroom.id}/roster`, {
    cookie: student.cookie
  });
  assert.equal(roster.status, 403);

  const rejoin = await callWorker(env, "/api/classes/join", {
    method: "POST",
    cookie: student.cookie,
    body: { code: removed.json.code }
  });
  assert.equal(rejoin.status, 403);

  const stale = await callWorker(env, "/api/auth/join", {
    method: "POST",
    body: { name: "Late", code: classroom.code }
  });
  assert.equal(stale.status, 400);

  // Brand-new students can still enroll with the rotated code.
  const fresh = await joinClass(env, removed.json.code, "Newbie");
  assert.equal(fresh.user.display_name, "Newbie");
});

test("quota exhaustion surfaces as HTTP 429", async () => {
  const env = createTestEnv();
  const { cookie } = await setupClassroom(env);

  env.__test.guard.allowed = false;
  try {
    const limited = await callWorker(env, "/api/classes", {
      method: "POST",
      cookie,
      body: { name: "Over quota" }
    });
    assert.equal(limited.status, 429);
  } finally {
    env.__test.guard.allowed = true;
  }
});

test("unknown routes return 404", async () => {
  const env = createTestEnv();
  const { cookie } = await setupClassroom(env);

  const missing = await callWorker(env, "/api/nope", { cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, "Not found.");
});

test("scheduled cleanup purges expired sessions, old messages and stale uploads", async () => {
  const env = createTestEnv();
  const { teacher, classroom } = await setupClassroom(env);
  const db = env.__test.db;
  const day = 86400000;
  const now = Date.now();

  const staleKey = "stale-object";
  await env.FILES.put(staleKey, new Uint8Array([1, 2, 3]));
  db.prepare(
    "INSERT INTO attachments(id, class_id, owner_id, r2_key, file_name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), classroom.id, teacher.id, staleKey, "old.png", "image/png", 3, now - 2 * day);

  db.prepare(
    "INSERT INTO messages(id, class_id, sender_id, client_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(crypto.randomUUID(), classroom.id, teacher.id, "old", "ancient", now - 31 * day);

  db.prepare(
    "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(await sha256hex("expired"), teacher.id, now - 1000);

  const pending = [];
  await worker.scheduled({}, env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);

  assert.equal(env.FILES.__keys().length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM attachments").get().n,
    0
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?")
      .get(await sha256hex("expired")).n,
    0
  );
  // The teacher's live session survives.
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n >= 1);
});

test("failed requests still set JSON content type and security headers", async () => {
  const env = createTestEnv();
  const result = await callWorker(env, "/api/me");

  assert.equal(result.status, 401);
  assert.match(
    result.response.headers.get("Content-Type"),
    /^application\/json; charset=utf-8$/
  );
  assert.equal(result.response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(result.response.headers.get("Cache-Control"), "no-store");
});
