// The CGSP Monitor page's decisions, kept apart from the page so node can test them
// (launcher/test/logic.test.js). The helper on the PC is the authority: it says whether the
// morning run is due, by its own clock, and refuses a run that is not. The page only asks.

export const DEFAULT_PORT = 47261;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

// "#pair=<token>&port=<port>", as `cgsp launcher pair-url` prints it. Anything else: null.
export function parsePairFragment(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const token = params.get("pair");
  if (!token || !TOKEN.test(token)) return null;
  const port = Number(params.get("port") || DEFAULT_PORT);
  return { token, port: validPort(port) ? port : DEFAULT_PORT };
}

export function validPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function validToken(token) {
  return typeof token === "string" && TOKEN.test(token);
}

// The message the helper's /pair window posts back, accepted only from that window's own
// loopback address on the expected port.
export function acceptPairMessage(event, port) {
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (!allowed.includes(event.origin)) return null;
  const data = event.data || {};
  if (data.type !== "cgsp-pair" || !validToken(data.token)) return null;
  const answered = Number(data.port);
  return { token: data.token, port: validPort(answered) ? answered : port };
}

// Ask for this morning's run at most once per morning from this page. The helper also
// refuses a second one, so two open tabs cannot send twice.
export function shouldTrigger(status, triggeredDay) {
  return Boolean(status && status.due_now && !status.busy && status.today && status.today.day !== triggeredDay);
}

// What the page asks the helper after reading its status: the morning run, and only ever
// that one, or nothing. app.js sends exactly this.
export function nextRequest(status, triggeredDay) {
  if (!shouldTrigger(status, triggeredDay)) return null;
  return { path: "/run", method: "POST", body: { kind: "scheduled" }, day: status.today.day };
}

// The run buttons wait while a run goes, including one a restarted helper found still going.
export function runButtonsDisabled(status) {
  return Boolean(status && (status.busy || (status.today && status.today.state === "running")));
}

// A copy of this page framed inside another site, where clicks can be stolen, does nothing.
export function isFramed(win) {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

// After the helper refused a key: forget the saved key only if it is the one refused. Another
// tab may have connected again in the meantime with a good one.
export function forgetRefusedKey(saved, refused) {
  return Boolean(saved) && saved === refused;
}

// Chrome has called this permission by several names; the current one first.
export const PERMISSION_NAMES = ["loopback-network", "local-network-access", "local-network"];

// Earlier mornings when no run started, shown until a morning runs again.
export function missedLine(status) {
  const days = (status && status.missed_days) || [];
  if (!days.length) return "";
  const list = days.length > 3 ? `${days.slice(0, 3).join(", ")} and ${days.length - 3} more` : days.join(", ");
  return `No morning run started on ${list}. The page has to be open and connected, and the computer awake, at ${status.send_time}.`;
}

// "HH:MM" of an ISO time written in the helper's timezone, as the helper sends it.
export function clockOf(iso) {
  const match = /T(\d\d):(\d\d)/.exec(String(iso || ""));
  return match ? `${match[1]}:${match[2]}` : "";
}

export function minutesOf(iso) {
  const clock = clockOf(iso);
  if (!clock) return 0;
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

// Where today's window and "now" sit on a 24-hour strip, in percent. A window that runs
// past midnight is cut at the end of the strip.
export function timeline(status) {
  const day = 24 * 60;
  const start = minutesOf(status.today.opens);
  const end = Math.min(day, start + status.late_window_minutes);
  return {
    start: (start / day) * 100,
    width: ((end - start) / day) * 100,
    now: (minutesOf(status.now_local) / day) * 100,
  };
}

// "in 3 h 5 min", "in 12 min", "now". From the helper's clock, never this computer's.
export function untilText(targetIso, helperNowMs) {
  const target = Date.parse(targetIso);
  if (Number.isNaN(target)) return "";
  const minutes = Math.round((target - helperNowMs) / 60000);
  if (minutes <= 0) return "now";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `in ${rest} min`;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

// How this morning's run stands, in plain words.
export function describe(status) {
  const time = status.send_time;
  const note = status.today.note || "";
  switch (status.today.state) {
    case "not-yet-due":
      return { tone: "calm", headline: `Waiting for ${time}`, detail: "Keep this page open. The run starts by itself at the send time." };
    case "due":
      return { tone: "busy", headline: "Starting the morning run", detail: "It is time. This page is asking the computer to start." };
    case "running":
      return { tone: "busy", headline: "Preparing today’s email", detail: note || "This usually takes 15 to 30 minutes. Leave the computer awake." };
    case "sent":
      return { tone: "good", headline: "Today’s email has gone", detail: note || "The morning run finished and Gmail accepted the email." };
    case "skipped":
      return { tone: "warn", headline: "No email this morning", detail: note };
    case "failed":
      return { tone: "bad", headline: "The morning run failed", detail: note || "See the log below. A failure notice is emailed when the run can send one." };
    case "paused":
      return { tone: "warn", headline: "The daily email is paused", detail: "Nothing goes out in the morning until you resume it." };
    case "missed":
      return { tone: "warn", headline: "This morning was missed", detail: `${note} The next run is tomorrow at ${time}.` };
    default:
      return { tone: "calm", headline: "Checking…", detail: "" };
  }
}

// Why the helper could not be reached. `permission` is Chrome's local-network permission
// state when it can be read ("granted", "denied", "prompt"), otherwise "". While Chrome is
// still asking, no call can reach the helper, so the answer is to click Allow.
export function connectionProblem({ httpStatus = 0, permission = "" } = {}) {
  if (httpStatus === 401) return "unpaired";
  if (httpStatus) return "error";
  if (permission === "denied") return "blocked";
  if (permission === "prompt") return "asking";
  return "down";
}
