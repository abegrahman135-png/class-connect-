const $ = selector => document.querySelector(selector);

const state = {
  user: null,
  classes: [],
  room: null,
  socket: null,
  generation: 0,
  retry: 0,
  reconnectTimer: null,
  messages: new Map(),
  pending: new Map(),
  roster: [],
  online: new Set(),
  attachment: null,
  uploading: false,
  recorder: null,
  recordingStream: null,
  recordingTimer: null,
  lastTyping: 0,
  lastRead: 0,
  ready: false
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", () => run(action));
  return node;
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $("#toast").hidden = true; }, 6500);
}

async function run(work) {
  try {
    await work();
  } catch (error) {
    toast(error.message || "Something went wrong.");
  }
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Blob)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function post(path, body = {}) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function showSecret(title, explanation, value) {
  $("#secret-title").textContent = title;
  $("#secret-explanation").textContent = explanation;
  $("#secret-value").value = value;
  $("#secret-dialog").showModal();
}

$("#copy-secret").onclick = () => run(async () => {
  await navigator.clipboard.writeText($("#secret-value").value);
  toast("Copied.");
});

$("#close-secret").onclick = () => {
  $("#secret-dialog").close();
  $("#secret-value").value = "";
};

$("#secret-dialog").addEventListener("cancel", event => event.preventDefault());

$("#login-form").onsubmit = event => {
  event.preventDefault();

  run(async () => {
    const form = new FormData(event.currentTarget);
    const result = await post("/auth/login", { key: form.get("key") });
    $("#login-form").reset();
    await enter(result.user);
  });
};

$("#enroll-form").onsubmit = event => {
  event.preventDefault();

  run(async () => {
    const form = new FormData(event.currentTarget);
    const result = await post("/auth/join", {
      name: form.get("name"),
      code: form.get("code")
    });

    $("#enroll-form").reset();

    // Show the only copy before any follow-up network request can fail.
    showSecret(
      "Save your account recovery key",
      "This key signs you in on another device. Store it privately. Your name and invitation code cannot recover this account.",
      result.recoveryKey
    );

    await enter(result.user);
  });
};

async function enter(user) {
  state.user = user;
  $("#auth").hidden = true;
  $("#workspace").hidden = false;
  $("#identity").textContent = `${user.display_name} · ${user.role}`;
  $("#create-class").hidden = user.role !== "teacher";
  await loadClasses();
}

async function loadClasses() {
  const data = await api("/classes");
  state.classes = data.classes;

  const list = $("#class-list");
  list.replaceChildren();

  for (const classroom of state.classes) {
    const node = button(classroom.name, () => openRoom(classroom), "class-tab");
    if (state.room?.id === classroom.id) node.classList.add("selected");
    list.append(node);
  }

  if (!state.room && state.classes.length) {
    await openRoom(state.classes[0]);
  }
}

$("#create-class").onclick = () => run(async () => {
  const name = prompt("Class name");
  if (!name?.trim()) return;

  const result = await post("/classes", { name });

  showSecret(
    "Class invitation code",
    "Share this only with your students. The server stores a hash, not the readable code.",
    result.code
  );

  await loadClasses();
});

$("#join-class").onclick = () => run(async () => {
  const code = prompt("Class invitation code");
  if (!code?.trim()) return;

  await post("/classes/join", { code });
  await loadClasses();
});

function stopRecording(discard = false) {
  if (state.recorder?.state === "recording") {
    state.recorder.discard = discard;
    state.recorder.stop();
  }

  clearTimeout(state.recordingTimer);
  state.recordingStream?.getTracks().forEach(track => track.stop());
  state.recordingStream = null;
}

$("#logout").onclick = () => run(async () => {
  if (state.pending.size && !confirm("Unsent messages will be discarded. Sign out?")) {
    return;
  }

  await post("/auth/logout");
  state.generation++;
  clearTimeout(state.reconnectTimer);
  stopRecording(true);
  state.socket?.close();
  location.reload();
});

function updateComposer() {
  const disabled = !state.room || state.uploading;
  $("#message-text").disabled = disabled;
  $("#file").disabled = disabled;
  $("#record").disabled = disabled;
  $("#send").disabled = disabled || !state.ready;

  $("#attachment-label").textContent = state.uploading
    ? "Uploading…"
    : state.attachment
      ? `Attached: ${state.attachment.file_name}`
      : "";

  $("#cancel-attachment").hidden = !state.attachment;
}

async function openRoom(classroom) {
  if (state.pending.size && !confirm("Discard unsent messages and switch classes?")) {
    return;
  }

  const generation = ++state.generation;
  clearTimeout(state.reconnectTimer);
  stopRecording(true);
  state.socket?.close();

  state.room = classroom;
  state.messages.clear();
  state.pending.clear();
  state.roster = [];
  state.online.clear();
  state.attachment = null;
  state.lastRead = 0;
  state.ready = false;
  state.retry = 0;

  $("#message-text").value = "";
  $("#room-title").textContent = classroom.name;
  $("#typing").textContent = "";
  $("#connection").textContent = "Connecting…";
  $("#rotate-invite").hidden = classroom.teacher_id !== state.user.id;
  $("#older").disabled = false;

  updateComposer();
  renderMessages();
  renderPending();

  for (const node of $("#class-list").children) {
    node.classList.toggle("selected", node.textContent === classroom.name);
  }

  await refreshRoster(generation);
  if (generation === state.generation) connect(generation);
}

async function refreshRoster(generation = state.generation) {
  if (!state.room) return;

  const data = await api(`/classes/${state.room.id}/roster`);
  if (generation !== state.generation) return;

  state.roster = data.members;
  renderRoster();
}

function connect(generation) {
  if (generation !== state.generation) return;

  const url = new URL(`/ws/classes/${state.room.id}`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  const socket = new WebSocket(url);
  state.socket = socket;

  socket.onmessage = event => {
    if (generation !== state.generation) return;

    run(async () => {
      const data = JSON.parse(event.data);

      if (data.type === "ready") {
        state.retry = 0;
        $("#connection").textContent = "Syncing…";

        // Refresh the loaded window as well as newer messages so deletions
        // made while offline are reconciled.
        await synchronize(generation);
        await refreshRoster(generation);

        if (generation !== state.generation) return;

        state.ready = true;
        $("#connection").textContent = "Connected";
        updateComposer();

        for (const item of state.pending.values()) transmit(item);
        markRead();
        return;
      }

      if (data.type === "presence") {
        state.online = new Set(data.userIds);
        renderRoster();
        return;
      }

      if (data.type === "typing" && data.userId !== state.user.id) {
        $("#typing").textContent = `${data.name} is typing…`;
        clearTimeout(connect.typingTimer);
        connect.typingTimer = setTimeout(() => {
          $("#typing").textContent = "";
        }, 5000);
        return;
      }

      if (data.type === "message:new" || data.type === "message:ack") {
        const message = data.message;
        state.messages.set(message.id, message);

        if (message.sender_id === state.user.id) {
          state.pending.delete(message.client_id);
        }

        renderMessages();
        renderPending();
        markRead();
        return;
      }

      if (data.type === "message:deleted") {
        const message = state.messages.get(data.id);
        if (message) {
          message.deleted = true;
          message.content = "";
          message.attachment = null;
          renderMessages();
        }
        return;
      }

      if (data.type === "message:read") {
        const member = state.roster.find(item => item.id === data.userId);
        if (member) member.last_read_seq = Math.max(member.last_read_seq, data.seq);
        renderMessages();
        return;
      }

      if (data.type === "roster:changed") {
        await refreshRoster(generation);
        return;
      }

      if (data.type === "error") {
        if (data.clientId && state.pending.has(data.clientId)) {
          const item = state.pending.get(data.clientId);
          item.status = data.message;
          renderPending();
        }
        toast(data.message);
      }
    });
  };

  socket.onclose = event => {
    if (generation !== state.generation) return;

    state.ready = false;
    updateComposer();

    if (event.code === 4001 || event.code === 4003) {
      $("#connection").textContent = event.reason || "Access unavailable";
      toast(event.reason || "Please sign in again.");
      return;
    }

    $("#connection").textContent = "Disconnected · reconnecting";

    const delay =
      Math.min(30000, 1000 * 2 ** state.retry++) + Math.random() * 500;

    state.reconnectTimer = setTimeout(() => connect(generation), delay);
  };

  socket.onerror = () => socket.close();
}

async function synchronize(generation) {
  const existing = [...state.messages.values()];
  let after = existing.length
    ? Math.min(...existing.map(message => message.seq)) - 1
    : null;

  if (after === null) {
    const data = await api(`/classes/${state.room.id}/messages`);
    if (generation !== state.generation) return;

    for (const message of data.messages) {
      state.messages.set(message.id, message);
      if (message.sender_id === state.user.id) {
        state.pending.delete(message.client_id);
      }
    }
  } else {
    while (true) {
      const data = await api(`/classes/${state.room.id}/messages?after=${after}`);
      if (generation !== state.generation) return;

      for (const message of data.messages) {
        state.messages.set(message.id, message);
        if (message.sender_id === state.user.id) {
          state.pending.delete(message.client_id);
        }
      }

      if (data.messages.length < 100) break;
      after = data.messages.at(-1).seq;
    }
  }

  renderMessages(true);
  renderPending();
}

$("#older").onclick = () => run(async () => {
  const messages = [...state.messages.values()];
  if (!messages.length) return;

  const generation = state.generation;
  const before = Math.min(...messages.map(message => message.seq));
  const data = await api(`/classes/${state.room.id}/messages?before=${before}`);

  if (generation !== state.generation) return;

  for (const message of data.messages) {
    state.messages.set(message.id, message);
  }

  $("#older").disabled = data.messages.length < 100;
  renderMessages(false);
});

function renderMessages(forceBottom = false) {
  const container = $("#messages");
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 100;

  const previousTop = container.scrollTop;
  container.replaceChildren();

  const messages = [...state.messages.values()].sort((a, b) => a.seq - b.seq);
  let previousSender = null;
  let previousTime = 0;
  let previousDay = "";

  for (const message of messages) {
    const date = new Date(message.created_at);
    const day = date.toLocaleDateString();

    if (day !== previousDay) {
      container.append(element("div", day, "day-rule"));
      previousDay = day;
      previousSender = null;
    }

    const row = element("article", undefined, "message");
    const grouped =
      previousSender === message.sender_id &&
      message.created_at - previousTime < 5 * 60000;

    if (!grouped) {
      const header = element("header", undefined, "message-header");
      header.append(
        element("strong", message.sender_name),
        element(
          "time",
          date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          "muted"
        )
      );
      row.append(header);
    }

    row.append(
      element(
        "p",
        message.deleted ? "Message removed by teacher." : message.content,
        message.deleted ? "muted" : "message-content"
      )
    );

    if (message.attachment && !message.deleted) {
      const attachment = message.attachment;
      const url = `/api/files/${attachment.id}`;

      const link = element(
        "a",
        `${attachment.file_name} · ${Math.ceil(attachment.size_bytes / 1024)} KB`,
        "attachment"
      );
      link.href = url;
      link.download = attachment.file_name;
      row.append(link);

      if (attachment.mime_type.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = url;
        row.append(audio);
      }
    }

    if (message.sender_id === state.user.id && !message.deleted) {
      const seen = state.roster.filter(member =>
        member.id !== state.user.id && member.last_read_seq >= message.seq
      ).length;

      row.append(element("small", seen ? `Saved · seen by ${seen}` : "Saved", "muted"));
    }

    if (state.room.teacher_id === state.user.id && !message.deleted) {
      row.append(button("Delete", async () => {
        if (!confirm("Remove this message from the class?")) return;

        await api(`/classes/${state.room.id}/messages/${message.id}`, {
          method: "DELETE"
        });
      }, "quiet"));
    }

    container.append(row);
    previousSender = message.sender_id;
    previousTime = message.created_at;
  }

  if (!messages.length) {
    container.append(element("p", "Your classroom conversation starts here.", "empty"));
  }

  if (forceBottom || nearBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollTop = previousTop;
  }
}

function transmit(item) {
  if (!state.ready || state.socket?.readyState !== WebSocket.OPEN) {
    item.status = "Waiting for connection";
    renderPending();
    return;
  }

  item.status = "Saving…";
  state.socket.send(JSON.stringify({
    type: "message:new",
    clientId: item.clientId,
    content: item.content,
    attachmentId: item.attachmentId
  }));

  renderPending();
}

function renderPending() {
  const container = $("#pending");
  container.replaceChildren();

  for (const item of state.pending.values()) {
    const row = element("div", undefined, "pending-row");
    row.append(element(
      "span",
      `${item.content || "Attachment"} — ${item.status}`
    ));

    row.append(button("Retry", () => transmit(item)));
    row.append(button("Discard", () => {
      state.pending.delete(item.clientId);
      renderPending();
    }));

    container.append(row);
  }
}

$("#composer").onsubmit = event => {
  event.preventDefault();

  const content = $("#message-text").value.trim();
  if (!content && !state.attachment) return;
  if (state.uploading) return;

  if (state.pending.size >= 10) {
    toast("Resolve your pending messages before sending more.");
    return;
  }

  const item = {
    clientId: crypto.randomUUID(),
    content,
    attachmentId: state.attachment?.id || null,
    status: "Waiting for connection"
  };

  state.pending.set(item.clientId, item);
  state.attachment = null;
  $("#message-text").value = "";
  updateComposer();
  transmit(item);
};

$("#message-text").addEventListener("input", () => {
  if (
    state.ready &&
    state.socket?.readyState === WebSocket.OPEN &&
    Date.now() - state.lastTyping > 3000
  ) {
    state.lastTyping = Date.now();
    state.socket.send(JSON.stringify({ type: "typing" }));
  }
});

function markRead() {
  const container = $("#messages");
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 120;

  if (!state.ready || document.hidden || !nearBottom) return;

  const seq = Math.max(0, ...[...state.messages.values()].map(message => message.seq));
  if (!seq || seq <= state.lastRead) return;

  state.lastRead = seq;
  state.socket.send(JSON.stringify({ type: "message:read", seq }));
}

$("#messages").addEventListener("scroll", () => {
  clearTimeout(markRead.timer);
  markRead.timer = setTimeout(markRead, 500);
});

document.addEventListener("visibilitychange", markRead);

async function uploadFile(file) {
  if (!state.room) return;
  if (file.size > 5 * 1024 * 1024) throw new Error("Maximum attachment size is 5 MiB.");

  const generation = state.generation;
  const classId = state.room.id;

  state.uploading = true;
  updateComposer();

  try {
    const params = new URLSearchParams({
      class: classId,
      name: file.name,
      size: String(file.size)
    });

    const result = await api(`/uploads?${params}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" }
    });

    if (generation === state.generation) state.attachment = result;
  } finally {
    state.uploading = false;
    updateComposer();
  }
}

$("#file").onchange = event => run(async () => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) await uploadFile(file);
});

$("#cancel-attachment").onclick = () => {
  state.attachment = null;
  updateComposer();
};

$("#record").onclick = () => run(async () => {
  if (state.recorder?.state === "recording") {
    stopRecording();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("Voice recording is unavailable in this browser.");
  }

  const mime = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus"
  ].find(type => MediaRecorder.isTypeSupported(type));

  if (!mime) throw new Error("This browser does not support a compatible audio format.");

  const generation = state.generation;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  if (generation !== state.generation) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  const chunks = [];
  let size = 0;

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    audioBitsPerSecond: 32000
  });

  state.recordingStream = stream;
  state.recorder = recorder;

  recorder.ondataavailable = event => {
    if (event.data.size) {
      chunks.push(event.data);
      size += event.data.size;
      if (size > 4 * 1024 * 1024) stopRecording();
    }
  };

  recorder.onerror = () => {
    stopRecording(true);
    toast("Recording failed.");
  };

  recorder.onstop = () => {
    stream.getTracks().forEach(track => track.stop());
    clearTimeout(state.recordingTimer);
    $("#record").textContent = "Record voice";
    state.recorder = null;

    if (recorder.discard || generation !== state.generation) return;

    run(async () => {
      const extension = mime.includes("ogg") ? "ogg" : "webm";
      const file = new File(chunks, `voice-${Date.now()}.${extension}`, {
        type: mime.split(";")[0]
      });
      await uploadFile(file);
    });
  };

  recorder.start(1000);
  $("#record").textContent = "Stop recording";
  state.recordingTimer = setTimeout(() => stopRecording(), 180000);
});

function renderRoster() {
  const container = $("#roster");
  container.replaceChildren();

  for (const member of state.roster) {
    const row = element("div", undefined, "roster-member");
    const online = state.online.has(member.id);

    row.append(
      element("span", online ? "●" : "○", online ? "online" : "muted"),
      element("strong", member.display_name),
      element("small", member.role + (member.muted ? " · muted" : ""), "muted")
    );

    if (
      state.room?.teacher_id === state.user.id &&
      member.id !== state.user.id
    ) {
      row.append(button(member.muted ? "Unmute" : "Mute", async () => {
        await api(`/classes/${state.room.id}/members/${member.id}`, {
          method: "PATCH",
          body: JSON.stringify({ muted: !member.muted })
        });
      }));

      row.append(button("Remove", async () => {
        if (!confirm(`Remove ${member.display_name}? The invitation code will also rotate.`)) {
          return;
        }

        const result = await api(
          `/classes/${state.room.id}/members/${member.id}`,
          { method: "DELETE" }
        );

        showSecret(
          "New invitation code",
          "The previous code has been invalidated. Share the new code only with approved students.",
          result.code
        );
      }));
    }

    container.append(row);
  }
}

$("#rotate-invite").onclick = () => run(async () => {
  if (!confirm("Invalidate the existing class invitation code?")) return;

  const result = await post(`/classes/${state.room.id}/invite`);

  showSecret(
    "New invitation code",
    "The previous invitation code no longer works.",
    result.code
  );
});

window.addEventListener("beforeunload", event => {
  if (state.pending.size || state.recorder?.state === "recording") {
    event.preventDefault();
    event.returnValue = "";
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    toast("Offline installation support could not be initialized.");
  });
}

run(async () => {
  try {
    const result = await api("/me");
    await enter(result.user);
  } catch (error) {
    if (error.status !== 401) throw error;
  }
});
