// One synchronous property write per player-state transition.
const PREFIX = 'roulette_table:game_store_v1:';
const LIMIT = 32767;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const natural = v => Number.isSafeInteger(v) && v >= 0;
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 128;
const name = v => typeof v === 'string' && v.length <= 128;
const scoreString = v => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const scoreCompare = (a,b) => a.length-b.length || compare(a,b);
const bad = (reason, revision) => revision === undefined ? {ok:false, reason} : {ok:false, reason, revision};

function keyFor(playerId) {
  if (!id(playerId)) return null;
  let encoded = '';
  for (let i=0;i<playerId.length;i++) encoded += playerId.charCodeAt(i).toString(16).padStart(4,'0');
  return PREFIX + encoded;
}

function bytes(s) {
  let size = 0;
  for (const char of s) {
    const n = char.codePointAt(0);
    size += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4;
  }
  return size;
}

/** Synchronous backend: getDynamicProperty, setDynamicProperty, getDynamicPropertyIds. */
export function createGameStore(world, {now = Date.now, validateSnapshot = () => true} = {}) {
  const validSnapshot = v => object(v) && validateSnapshot(v) === true;
  function decode(key, raw) {
    if (typeof raw !== 'string' || bytes(raw) > LIMIT) return null;
    const r = JSON.parse(raw);
    if (!object(r) || r.schemaVersion !== 1 || keyFor(r.playerId) !== key || !natural(r.revision) || !r.revision) return null;
    if (r.runId === null ? r.snapshot !== null : !id(r.runId) || !validSnapshot(r.snapshot)) return null;
    const b = r.best, l = r.lastResult;
    if (b !== null && !(object(b) && id(b.runId) && scoreString(b.score) && name(b.displayName) && natural(b.achievedAt) && natural(b.tieOrder))) return null;
    if (l !== null && !(object(l) && id(l.runId) && (l.score === null || scoreString(l.score)) && natural(l.finishedAt))) return null;
    if (r.runId !== null && (r.runId === b?.runId || r.runId === l?.runId)) return null;
    return r;
  }

  function read(playerId) {
    const key = keyFor(playerId);
    if (!key) return bad('invalid-player');
    let raw;
    try { raw = world.getDynamicProperty(key); } catch { return bad('storage-error'); }
    if (raw === undefined) return {ok:true, key, record:{schemaVersion:1, playerId, revision:0, runId:null, snapshot:null, best:null, lastResult:null}};
    try {
      const record = decode(key, raw);
      if (record) return {ok:true, key, record};
    } catch { /* Do not overwrite unreadable state. */ }
    return bad('corrupt');
  }

  function load(playerId) {
    const result = read(playerId);
    if (!result.ok) return result;
    const {revision, runId, snapshot, best, lastResult} = result.record;
    return {ok:true, revision, runId, snapshot, best, lastResult};
  }

  function write(entry, record) {
    const revision = entry.record.revision;
    if (revision === Number.MAX_SAFE_INTEGER) return bad('revision-exhausted',revision);
    record.revision = revision+1;
    const encoded = JSON.stringify(record);
    if (bytes(encoded) > LIMIT) return bad('oversized',revision);
    try { world.setDynamicProperty(entry.key, encoded); } catch { return bad('storage-error',revision); }
    return {ok:true, revision:record.revision};
  }

  function save(playerId, expectedRevision, runId, snapshot, {replace = false} = {}) {
    const entry = read(playerId);
    if (!entry.ok) return entry;
    const record = entry.record, {revision} = record;
    if (expectedRevision !== revision) return bad('conflict',revision);
    if (!id(runId)) return bad('invalid-run',revision);
    if (runId === record.lastResult?.runId || runId === record.best?.runId) return bad('finalized',revision);
    if (record.runId !== null && record.runId !== runId && replace !== true) return bad('replace-required',revision);
    let copy;
    try {
      copy = JSON.parse(JSON.stringify(snapshot, (_, v) => {
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || (typeof v === 'number' && !Number.isFinite(v))) throw Error('non-JSON data');
        return v;
      }));
      if (!validSnapshot(copy)) return bad('invalid-snapshot',revision);
    } catch { return bad('invalid-snapshot',revision); }
    return write(entry, {...record, runId, snapshot:copy});
  }

  function scan() {
    const entries = [];
    let skipped = 0;
    for (const key of new Set(world.getDynamicPropertyIds())) {
      if (!key.startsWith(PREFIX)) continue;
      const raw = world.getDynamicProperty(key);
      if (raw === undefined) continue;
      let r;
      try { r = decode(key, raw); } catch { /* Treat malformed records as skipped. */ }
      if (!r) skipped++;
      else if (r.best) entries.push({playerId:r.playerId, ...r.best});
    }
    return {entries, skipped};
  }

  function finalize(playerId, expectedRevision, runId, {score = null, displayName = ''} = {}) {
    const entry = read(playerId);
    if (!entry.ok) return entry;
    const record = entry.record, {revision} = record;
    if (!id(runId)) return bad('invalid-run',revision);
    if (record.lastResult?.runId === runId) return {ok:true, duplicate:true, revision, result:record.lastResult, best:record.best};
    if (expectedRevision !== revision) return bad('conflict',revision);
    if (record.runId !== runId) return bad('run-mismatch',revision);
    if (score !== null && !scoreString(score)) return bad('invalid-score',revision);
    if (!name(displayName)) return bad('invalid-name',revision);
    let finishedAt;
    try { finishedAt = now(); } catch { return bad('invalid-clock',revision); }
    if (!natural(finishedAt)) return bad('invalid-clock',revision);
    let best = record.best;
    if (score !== null && (!best || scoreCompare(score,best.score) > 0)) {
      // Order equal scores by attainment even when two players finish in the same millisecond.
      let tieOrder = 0;
      try {
        for (const row of scan().entries) if (row.score === score) tieOrder = Math.max(tieOrder,row.tieOrder+1);
      } catch { return bad('storage-error',revision); }
      if (!natural(tieOrder)) return bad('order-exhausted',revision);
      best = {runId, displayName, score, achievedAt:finishedAt, tieOrder};
    }
    const result = {runId, score, finishedAt};
    const saved = write(entry,{...record, runId:null, snapshot:null, best, lastResult:result});
    return saved.ok ? {...saved, duplicate:false, result, best} : saved;
  }

  function leaderboard(page = 0, pageSize = 10) {
    if (!natural(page) || !natural(pageSize) || pageSize < 1 || pageSize > 100 || !natural(page*pageSize)) return bad('invalid-page');
    let data;
    try { data = scan(); } catch { return bad('storage-error'); }
    const {entries, skipped} = data;
    entries.sort((a,b) => scoreCompare(b.score,a.score) || a.tieOrder-b.tieOrder || compare(a.playerId,b.playerId));
    const offset = page*pageSize;
    const rows = entries.slice(offset,offset+pageSize).map(({playerId,displayName,score,achievedAt},i) => ({rank:offset+i+1, playerId,displayName,score,achievedAt}));
    return {ok:true, entries:rows, total:entries.length, page, pageSize, skipped};
  }

  return {load, save, finalize, leaderboard};
}
