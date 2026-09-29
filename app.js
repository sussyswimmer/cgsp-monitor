// CGSP Monitor page: talks to the CGSP helper on this PC (http://127.0.0.1:<port>).
// It polls once a minute and, when the helper says the morning run is due, asks for it once.
// The helper decides by its own clock and refuses anything not due, so a wrong clock or a
// second open tab here can never send an extra email.
import {
  DEFAULT_PORT, PERMISSION_NAMES, acceptPairMessage, clockOf, connectionProblem, describe,
  forgetRefusedKey, isFramed, missedLine, nextRequest, parsePairFragment, runButtonsDisabled,
  timeline, untilText, validPort, validToken,
} from "./logic.js";

// Another site could show this page in a frame and steal clicks on it. Framed, it does nothing.
if (isFramed(window)) {
  document.body.textContent = "Open CGSP Monitor directly, in its own tab.";
  throw new Error("CGSP Monitor refuses to run inside a frame.");
}

const POLL_MS = 60_000;
const BUSY_POLL_MS = 15_000;
const REQUEST_MS = 10_000;
const $ = (id) => document.getElementById(id);

// ---- the pairing key, kept in this browser only

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private window */ } },
};

let token = store.get("cgsp.token") || "";
let port = Number(store.get("cgsp.port")) || DEFAULT_PORT;
if (!validToken(token)) token = "";
if (!validPort(port)) port = DEFAULT_PORT;

// A connection link (`cgsp launcher pair-url`) carries a key in the address. It is kept only
// once the helper accepts it, so a link from anywhere else cannot disconnect this browser.
// The address bar is cleaned at once; Chrome's history still keeps the full address, which
// is why the Connect button is the better way to connect.
const offered = parsePairFragment(location.hash);
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

const base = (target = port) => `http://127.0.0.1:${target}`;

function forget() {
  token = "";
  port = DEFAULT_PORT;
  store.remove("cgsp.token");
  store.remove("cgsp.port");
}

// ---- talking to the helper

class HelperError extends Error {
  constructor(httpStatus, body) {
    super((body && body.message) || `The helper answered ${httpStatus}.`);
    this.httpStatus = httpStatus;
    this.body = body || {};
  }
}

async function call(path, { method = "GET", body, key = token, target = port } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_MS);
  try {
    const response = await fetch(base(target) + path, {
      method,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = response.headers.get("Content-Type") || "";
    const payload = type.includes("json") ? await response.json() : await response.text();
    if (!response.ok) throw new HelperError(response.status, typeof payload === "object" ? payload : null);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function localNetworkPermission() {
  if (!navigator.permissions) return "";
  for (const name of PERMISSION_NAMES) {
    try {
      return (await navigator.permissions.query({ name })).state;
    } catch { /* not a permission this browser knows */ }
  }
  return "";
}

// ---- state

let status = null;
let offsetMs = 0; // helper clock minus this computer's clock
let triggeredDay = store.get("cgsp.triggered") || "";
let pollTimer = 0;
let inFlight = false;
let lastAnnounced = "";
let unconfirmed = null; // a connection link's key the helper has not accepted yet

function helperNow() {
  return Date.now() + offsetMs;
}

function announce(text) {
  if (text && text !== lastAnnounced) {
    lastAnnounced = text;
    $("announce").textContent = text;
  }
}

function setConnection(tone, title, detail = "") {
  $("connection").dataset.tone = tone;
  $("connection-title").textContent = title;
  $("connection-detail").textContent = detail;
}

function showSections({ pair = false, connected = false } = {}) {
  $("pair").hidden = !pair;
  for (const id of ["today", "actions", "last"]) $(id).hidden = !connected;
  $("forget").hidden = !token;
  if (connected && !(status && status.last_run) && !(status && status.last_report)) $("last").hidden = true;
}

// ---- drawing

function render() {
  const s = status;
  const words = describe(s);
  document.querySelectorAll("[data-send-time]").forEach((el) => { el.textContent = s.send_time; });

  const today = $("today");
  today.dataset.tone = words.tone;
  $("today-date").textContent = `Today · ${s.today.day}`;
  $("today-title").textContent = words.headline;
  $("today-detail").textContent = words.detail;
  const missed = missedLine(s);
  $("missed").hidden = !missed;
  $("missed").textContent = missed;
  $("next-time").textContent = clockOf(s.next_run);
  const sameDay = s.next_run.slice(0, 10) === s.now_local.slice(0, 10);
  $("next-when").textContent = `${sameDay ? "today" : "tomorrow"}, ${untilText(s.next_run, helperNow())}`;

  const line = timeline(s);
  $("dial-window").style.left = `${line.start}%`;
  $("dial-window").style.width = `${line.width}%`;
  $("dial-now").style.left = `${line.now}%`;
  $("dial-now-label").textContent = clockOf(s.now_local);
  $("dial-caption").textContent =
    `The run may start from ${clockOf(s.today.opens)} to ${clockOf(s.today.closes)} (${s.timezone}). ` +
    `Times are this computer's helper clock.`;

  $("paused-banner").hidden = !s.paused;
  $("pause-row").hidden = s.paused;

  const running = runButtonsDisabled(s);
  $("progress").hidden = !running;
  if (running) {
    $("progress-text").textContent = {
      scheduled: "The morning run is going. Keep the computer awake until it finishes.",
      now: "Sending to everyone now. This usually takes 15 to 30 minutes.",
      preview: "Building the free preview. This takes a few minutes.",
    }[s.active_kind || "scheduled"] || "A run is going.";
  }
  for (const id of ["preview", "send-now"]) $(id).disabled = running;
  $("open-preview").hidden = !(s.preview && s.preview.available && !s.preview.running);

  renderLast(s);
  $("helper-version").textContent = `Helper ${s.version}${s.commit ? ` (${s.commit})` : ""}` +
    (s.settings_problem ? ` · ${s.settings_problem}` : "");
  announce(`${words.headline}. ${words.detail}`);
}

function fact(label, value) {
  const wrap = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  wrap.append(dt, dd);
  return wrap;
}

function renderLast(s) {
  const last = s.last_run;
  const report = (last && last.report) || s.last_report;
  const facts = $("last-facts");
  facts.replaceChildren();
  if (last) {
    const kind = { scheduled: "Morning run", now: "Send to everyone now", preview: "Free preview" }[last.kind] || last.kind;
    facts.append(fact("What", kind));
    facts.append(fact("Started", `${last.started_at.slice(0, 16).replace("T", " ")} UTC`));
    const outcome = last.running ? "Running" : last.exit_code === 0 ? "Finished" : last.exit_code == null ? "Unknown" : `Failed (code ${last.exit_code})`;
    facts.append(fact("Outcome", outcome));
  }
  if (report) {
    facts.append(fact("Digest date", report.run_date || "—"));
    facts.append(fact("Sources checked", `${report.sources_checked ?? "—"} (${report.sources_failed ?? 0} failed)`));
    facts.append(fact("Relevant stories", String(report.classified_relevant ?? "—")));
    facts.append(fact("Emails sent", String(report.emails_sent ?? "—")));
    if (report.degraded && report.degraded.length) facts.append(fact("Notes", report.degraded.join("; ")));
  }
  $("last").hidden = !(last || report);
  const log = $("last-log");
  const lines = (last && last.log) || [];
  log.hidden = !lines.length;
  log.textContent = lines.join("\n");
}

// ---- the loop

function schedule() {
  clearTimeout(pollTimer);
  const busy = status && status.busy && document.visibilityState === "visible";
  pollTimer = setTimeout(poll, busy ? BUSY_POLL_MS : POLL_MS);
}

async function poll() {
  if (inFlight) return;
  if (!token) {
    setConnection("warn", "Not connected to this computer yet", "Connect once, below. This page then starts the morning run by itself while it stays open.");
    showSections({ pair: true });
    schedule();
    return;
  }
  inFlight = true;
  const used = token;
  try {
    const fresh = await call("/status");
    offsetMs = Date.parse(fresh.now_utc) - Date.now();
    status = fresh;
    if (unconfirmed && unconfirmed.token === used) keep(unconfirmed);
    unconfirmed = null;
    setConnection("good", "Connected to this computer", "");
    showSections({ connected: true });
    render();
    const request = nextRequest(status, triggeredDay);
    if (request) await trigger(request);
  } catch (error) {
    await showProblem(error, used);
  } finally {
    inFlight = false;
    schedule();
  }
}

async function trigger(request) {
  try {
    const answer = await call(request.path, { method: request.method, body: request.body });
    triggeredDay = request.day;
    store.set("cgsp.triggered", request.day);
    status = answer.status;
    render();
  } catch (error) {
    if (error instanceof HelperError && (error.httpStatus === 409 || error.httpStatus === 403)) {
      // Already going, or no longer due: the helper's answer stands, and the next poll shows it.
      triggeredDay = request.day;
      return;
    }
    throw error; // anything else: asked again at the next poll, while the window is open
  }
}

async function showProblem(error, used = token) {
  const httpStatus = error instanceof HelperError ? error.httpStatus : 0;
  const permission = httpStatus ? "" : await localNetworkPermission();
  const problem = connectionProblem({ httpStatus, permission });
  if (problem === "unpaired") {
    unconfirmed = null;
    const saved = store.get("cgsp.token") || "";
    if (forgetRefusedKey(saved, used)) {
      forget();
    } else if (validToken(saved)) {
      token = saved; // another tab connected again meanwhile
      port = Number(store.get("cgsp.port")) || DEFAULT_PORT;
    } else {
      forget();
    }
    setConnection("warn", "This browser needs connecting again", "The helper on this computer has a new key. Press Connect below.");
    showSections({ pair: !token });
  } else if (problem === "blocked") {
    setConnection("bad", "Chrome is blocking this page from reaching this computer",
      "Click the icon at the left of the address bar, open Site settings, set Local network access (apps on this device) to Allow, then reload this page.");
    showSections({ connected: false });
  } else if (problem === "asking") {
    setConnection("warn", "Chrome is asking for permission: click Allow",
      "In the box under the address bar (“Access other apps and services on this device”), choose Allow. Until then this page cannot reach this computer, and the morning run cannot start. No box? Reload this page.");
    showSections({ connected: false });
  } else if (problem === "down") {
    setConnection("bad", "The helper on this computer is not answering",
      "It starts when you sign in to Windows. To start it now, open Task Scheduler, find “CGSP Launcher” and choose Run, or sign out and back in. This page only works on the PC that sends the email.");
    showSections({ connected: false });
  } else {
    setConnection("bad", "The helper answered with a problem", error.message);
  }
  announce($("connection-title").textContent);
}

// ---- buttons

function result(text, tone = "") {
  const node = $("action-result");
  node.textContent = text;
  node.dataset.tone = tone;
}

async function start(kind, message) {
  result("");
  try {
    const answer = await call("/run", { method: "POST", body: { kind } });
    status = answer.status;
    render();
    result(message, "good");
  } catch (error) {
    result(error instanceof HelperError ? error.message : "The helper did not answer. Nothing was started.", "bad");
  }
  schedule();
}

async function setPaused(paused) {
  result("");
  try {
    const answer = await call("/pause", { method: "POST", body: { paused } });
    status = answer.status;
    render();
    result(paused ? "Paused. No morning email until you resume it." : "Resumed. The next morning run goes ahead.", "good");
  } catch (error) {
    result(error instanceof HelperError ? error.message : "The helper did not answer. Nothing changed.", "bad");
  }
}

function keep(candidate) {
  token = candidate.token;
  port = candidate.port;
  store.set("cgsp.token", token);
  store.set("cgsp.port", String(port));
}

async function adopt(candidate) {
  try {
    await call("/status", { key: candidate.token, target: candidate.port });
  } catch (error) {
    if (error instanceof HelperError) return; // refused: the earlier connection stays
    // Not reachable yet (Chrome may still be asking for permission): used for now, and
    // saved only once the helper accepts it.
    unconfirmed = candidate;
    token = candidate.token;
    port = candidate.port;
    return;
  }
  keep(candidate);
}

$("connect").addEventListener("click", () => {
  const popup = window.open(`${base()}/pair`, "cgsp-pair", "width=440,height=280");
  if (!popup) setConnection("warn", "The connect window was blocked", "Allow popups for this site in the address bar, then press Connect again.");
});

window.addEventListener("message", (event) => {
  const accepted = acceptPairMessage(event, port);
  if (!accepted) return;
  token = accepted.token;
  port = accepted.port;
  store.set("cgsp.token", token);
  store.set("cgsp.port", String(port));
  poll();
});

$("preview").addEventListener("click", () => start("preview", "Preview started. It appears here when it is ready."));
$("send-now").addEventListener("click", () => $("confirm").showModal());
$("confirm").addEventListener("close", () => {
  if ($("confirm").returnValue === "send") start("now", "Started. The email goes to everyone as soon as the run finishes.");
});
$("pause").addEventListener("click", () => setPaused(true));
$("resume").addEventListener("click", () => setPaused(false));
$("forget").addEventListener("click", () => {
  forget();
  status = null;
  showSections({ pair: true });
  poll();
});
$("open-preview").addEventListener("click", async () => {
  try {
    $("preview-frame").srcdoc = await call("/preview");
    $("preview-dialog").showModal();
  } catch (error) {
    result(error instanceof HelperError ? error.message : "The preview could not be loaded.", "bad");
  }
});

// Chrome's Memory Saver may have put this tab to sleep. A sleeping tab runs nothing, so it
// could not start the morning run: say so, and how to stop it happening.
$("slept").hidden = !document.wasDiscarded;

// Chrome slows timers in background tabs to about once a minute, and may put a tab to sleep.
// Checking again whenever the tab or the network comes back covers both.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
window.addEventListener("focus", poll);
window.addEventListener("online", poll);
setInterval(() => { if (status) render(); }, 30_000);

(offered ? adopt(offered) : Promise.resolve()).then(poll);
