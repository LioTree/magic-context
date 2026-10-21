// Magic Context subagent failure sentinel, run by basal every five minutes.
//
// It reads finished subagent invocations from ck-mc's read-only
// `subagent_invocations.read` op and wakes MC when failures look new or are
// growing. The rules are a port of `evaluateFailures` in
// packages/plugin/scripts/subagent-failure-sentinel.ts, and
// packages/plugin/scripts/subagent-failure-sentinel-flow.test.ts checks that
// both produce the same alerts on the same rows. A change to the rules belongs
// in both places until that script is retired.
//
// basal wraps this text in an async function, so top-level `await` and
// `return` work. The runtime has no console, timers or TextEncoder.

const MODULE = 'magic-context';
const OP = 'subagent_invocations.read';
const AGENT = 'MC';
const STATE_KEY = 'state';

const HOUR = 3600000;
const DAY = 24 * HOUR;
// A primary attempt that fails is followed by its fallback attempt, which ends
// later. Rows are judged only once they are this old, which gives the fallback
// time to finish before its outcome is checked.
const SETTLE_MS = 5 * 60000;
// Some fallback rows carry no parent link. Such a row still counts as a
// primary's fallback when it has task `fallback`, the same subagent and session,
// and starts between 5 seconds before and this long after the primary ends.
const FALLBACK_START_WINDOW_MS = 120000;
const QUOTA_ERROR =
  /account pool has no account|quota|rate[ _-]?limit|too many requests|\b429\b|resource_exhausted|usage limit/i;
// prefrontal-core refuses a digest body over this many UTF-8 bytes.
const BODY_MAX_BYTES = 4096;
const CONTENT_PREFIX = 'Magic Context subagent failure sentinel: ';
// The script's bounds: new rows judged per run, and history rows read for them.
const MAX_NEW = 500;
const MAX_HISTORY = 5000;

function normalizeError(error) {
  return (error === null || error === undefined ? '(no error)' : error)
    .replace(/(?:[a-zA-Z]:)?(?:\/[\w.~-]+){2,}/g, '<path>')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, '<id>')
    // Recorded errors are cut at a fixed length, which can split a UUID;
    // the surviving prefix (8 hex digits plus partial groups) is still an id.
    .replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{1,12})+/gi, '<id>')
    .replace(/\b(?:0x[a-f0-9]+|[a-f0-9]{16,}|(?:session|task|run|agent|invocation|request|trace|job|msg|wi|ct)_[a-z0-9_-]+)\b/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi, '<duration>')
    // Compact countdowns such as "34h 33m 37s" change on every report of the
    // same failure, so they must collapse into one class.
    .replace(/\b\d+[dhms](?:\s+\d+[dhms])*\b/gi, '<duration>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
}

// The rules compare classes of the same rows many times over; QuickJS has no JIT,
// so each distinct error text is normalized once per run.
const errorClasses = new Map();
function errorClass(error) {
  const text = error === null || error === undefined ? null : error;
  if (!errorClasses.has(text)) errorClasses.set(text, normalizeError(text));
  return errorClasses.get(text);
}

function cursorAfter(row, cursor) {
  return row.ended_at > cursor.ended_at || (row.ended_at === cursor.ended_at && row.id > cursor.id);
}

function alertKey(alert) {
  // The share rule describes the whole task, so one burst of mixed failure classes
  // must dedupe to a single alert instead of re-firing for every class it contains.
  const klass = alert.rule === 'failure_share' ? '*' : alert.class;
  return JSON.stringify([alert.rule, alert.subagent, alert.task, klass]);
}

// Ids of quota or rate-limit failures that a completed fallback attempt recovered.
// The run produced its result on the fallback model, so the primary's quota error
// is expected while that provider is exhausted and is not worth a wake. A fallback
// that also fails leaves the primary unrecovered, so its failure stays eligible for
// the alert rules.
function recoveredByFallback(rows) {
  const recovered = new Set();
  for (const row of rows) {
    if (row.status !== 'failed' && row.status !== 'timed_out') continue;
    if (!QUOTA_ERROR.test(row.error === null || row.error === undefined ? '' : row.error)) continue;
    const fallbackCompleted = rows.some(
      (candidate) =>
        candidate.status === 'completed' &&
        (candidate.parent_invocation_id === row.id ||
          (candidate.parent_invocation_id === null &&
            candidate.task === 'fallback' &&
            candidate.subagent === row.subagent &&
            candidate.session_id === row.session_id &&
            candidate.started_at >= row.ended_at - 5000 &&
            candidate.started_at <= row.ended_at + FALLBACK_START_WINDOW_MS)),
    );
    if (fallbackCompleted) recovered.add(row.id);
  }
  return recovered;
}

function evaluateFailures(allRows, allNewRows, now, completeSince) {
  // A recovered attempt is neither a failure nor a success of its task, so it is
  // left out of every rule, including the share denominator.
  const recovered = recoveredByFallback(allRows);
  const rows = allRows.filter((row) => !recovered.has(row.id));
  const newRows = allNewRows.filter((row) => !recovered.has(row.id));
  const failures = (row) => row.status === 'failed' || row.status === 'timed_out';
  const taskName = (row) => (row.task === null || row.task === undefined ? '(untitled)' : row.task);
  const alerts = [];
  const seen = new Set();
  for (const row of newRows) {
    if (!failures(row) || row.ended_at < now - DAY) continue;
    const task = taskName(row);
    const klass = errorClass(row.error);
    const group = rows.filter((candidate) => candidate.subagent === row.subagent && taskName(candidate) === task);
    const current = group.filter((candidate) => candidate.ended_at > now - DAY);
    const prior = group.filter((candidate) => candidate.ended_at > now - 2 * DAY && candidate.ended_at <= now - DAY);
    const classRows = current.filter((candidate) => failures(candidate) && errorClass(candidate.error) === klass);
    const oldClass = prior.filter((candidate) => failures(candidate) && errorClass(candidate.error) === klass);
    const failuresToday = current.filter(failures).length;
    const share = current.length ? failuresToday / current.length : 0;
    // Field order matches the script's alert objects, so both serialize alike.
    const base = {
      subagent: row.subagent,
      task,
      class: klass,
      count: classRows.length,
      share,
      example_error: row.error === null || row.error === undefined ? '(no error)' : row.error,
      newest_session_id: classRows.length ? classRows[0].session_id : row.session_id,
      empty: current.filter((candidate) => candidate.status === 'empty').length,
      aborted: current.filter((candidate) => candidate.status === 'aborted').length,
    };
    const earlier = rows.some((candidate) =>
      candidate.subagent === row.subagent && taskName(candidate) === task && failures(candidate) &&
      errorClass(candidate.error) === klass && candidate.ended_at >= row.ended_at - 7 * DAY &&
      candidate.ended_at < row.ended_at && cursorAfter(row, candidate));
    const rules = [];
    if (completeSince <= now - 7 * DAY && !earlier) rules.push('new_class');
    if (completeSince <= now - DAY && current.length >= 8 && share >= 0.25) rules.push('failure_share');
    if (completeSince <= now - 2 * DAY && oldClass.length > 0 && classRows.length >= 2 * oldClass.length) rules.push('class_doubled');
    for (const rule of rules) {
      // A share alert counts every failure of the task, so the 50% re-alert
      // threshold tracks the task's failures rather than one class's.
      const alert = rule === 'failure_share'
        ? Object.assign({ rule }, base, { class: '*', count: failuresToday })
        : Object.assign({ rule }, base);
      const id = alertKey(alert);
      if (!seen.has(id)) { alerts.push(alert); seen.add(id); }
    }
  }
  return alerts;
}

function invalidState() {
  throw new Error('invalid failure sentinel state');
}

// Missing state starts the cursor five minutes back, as the script's first run did.
function loadState(stored, now) {
  if (stored === null || stored === undefined) {
    return { version: 1, cursor: { ended_at: now - 5 * 60000, id: 0 }, sent: {} };
  }
  if (typeof stored !== 'object') invalidState();
  const cursor = stored.cursor;
  if (stored.version !== 1 || !cursor || !Number.isSafeInteger(cursor.ended_at) ||
    !Number.isSafeInteger(cursor.id) || !stored.sent || typeof stored.sent !== 'object') {
    invalidState();
  }
  return stored;
}

function utf8Bytes(text) {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// The script's wake text when it fits a digest body. A larger set keeps as many
// whole alerts as fit, with long example errors shortened, and says how many
// were left out; the full count is also in the item's data.
function digestBody(alerts) {
  const full = CONTENT_PREFIX + JSON.stringify(alerts);
  if (utf8Bytes(full) <= BODY_MAX_BYTES) return full;
  const shortened = alerts.map((alert) =>
    Object.assign({}, alert, {
      example_error: alert.example_error.length > 300
        ? alert.example_error.slice(0, 300) + '…'
        : alert.example_error,
    }));
  for (let kept = shortened.length; kept > 0; kept--) {
    const omitted = shortened.length - kept;
    const suffix = omitted ? ` (${omitted} more alert${omitted === 1 ? '' : 's'} not shown)` : '';
    const text = CONTENT_PREFIX + JSON.stringify(shortened.slice(0, kept)) + suffix;
    if (utf8Bytes(text) <= BODY_MAX_BYTES) return text;
  }
  return `${CONTENT_PREFIX}${alerts.length} alerts; none fits a digest body.`;
}

// Reads up to `limit` rows of one query. ck-mc keeps each reply under basal's
// 512 KiB result cap, so a query can take several pages, each continuing from
// the previous page's last row through `cursorField`. `more` says whether a
// matching row exists past the last one returned.
async function readRows(args, cursorField, limit) {
  const rows = [];
  let more = true;
  while (rows.length < limit && more) {
    const request = Object.assign({}, args, { limit: limit - rows.length });
    if (rows.length) {
      const last = rows[rows.length - 1];
      request[cursorField] = { ended_at: last.ended_at, id: last.id };
    }
    const page = await ops.call(MODULE, OP, request);
    more = page.more;
    // ck-mc returns at least one row whenever one matches; stop rather than loop.
    if (!page.rows.length) break;
    for (const row of page.rows) rows.push(row);
  }
  return { rows, more };
}

// ---- The run ----
// Everything above only defines constants and functions; the equivalence test
// loads it on its own by cutting the script at this marker.

const now = Date.now();
const state = loadState(await kv.get(STATE_KEY), now);
for (const key of Object.keys(state.sent)) {
  if (now - state.sent[key].at >= 6 * HOUR) delete state.sent[key];
}

let examined = 0;
let bounded = false;
let historyRead = false;
let alerts = [];
const next = await readRows(
  { query: 'after_cursor', cursor: state.cursor, settled_before: now - SETTLE_MS },
  'cursor',
  MAX_NEW,
);
const fresh = next.rows;
examined += fresh.length + (next.more ? 1 : 0);
bounded = next.more;
// Only a new failure can raise an alert, so a batch without one skips the
// history read; the script read it anyway and found nothing to report.
if (fresh.some((row) => row.status === 'failed' || row.status === 'timed_out')) {
  const history = await readRows({ query: 'window', after: now - 7 * DAY, until: now }, 'before', MAX_HISTORY);
  historyRead = true;
  const rows = history.rows;
  examined += rows.length + (history.more ? 1 : 0);
  bounded = bounded || history.more;
  // A cut-off history covers only back to its oldest row, which keeps the rules
  // that need a full window from firing on partial data.
  const completeSince = history.more ? rows[rows.length - 1].ended_at : now - 7 * DAY;
  alerts = evaluateFailures(rows, fresh, now, completeSince).filter((alert) => {
    const previous = state.sent[alertKey(alert)];
    return !previous || now - previous.at >= 6 * HOUR || alert.count >= Math.ceil(previous.count * 1.5);
  });
}
if (fresh.length) {
  const last = fresh[fresh.length - 1];
  state.cursor = { ended_at: last.ended_at, id: last.id };
}

if (alerts.length) {
  const deliveryId = `mc-subagent-failure-${now}-${state.cursor.id}`;
  // Reserve the dedupe keys before delivery so an ambiguous delivery cannot cause a repeated wake.
  for (const alert of alerts) state.sent[alertKey(alert)] = { at: now, count: alert.count };
  await kv.set(STATE_KEY, state);
  const item = {
    title: `Magic Context subagent failure sentinel: ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`,
    body: digestBody(alerts),
    data: { delivery_id: deliveryId, alerts: alerts.length, bounded },
  };
  // The delivery id as replace_key makes a replayed write replace, not repeat, this run's item.
  try {
    await sink.digest(AGENT, item, 'wake', { replace_key: deliveryId });
  } catch (e) {
    if (!e || !e.data || e.data.code !== 'digest_replace_key_unsupported') throw e;
    await sink.digest(AGENT, item, 'wake');
  }
} else {
  await kv.set(STATE_KEY, state);
}

return { examined, alerts: alerts.length, bounded, history_read: historyRead, watermark: state.cursor };
