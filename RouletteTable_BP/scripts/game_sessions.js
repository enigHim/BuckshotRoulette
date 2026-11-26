// Coordinates active table ownership with a persistent per-player run.
export function createSessions({ store, createRun, applyAction, makeRunId }) {
  const players = new Map(), tables = new Map();
  const fail = reason => ({ ok:false, reason });
  let nextSession = 0;
  const token = s => ({ sessionId:s.sessionId, runId:s.runId, revision:s.revision, tableKey:s.tableKey });
  const view = s => ({ ...token(s), state:JSON.parse(JSON.stringify(s.state)) });
  const current = playerId => {
    const s = players.get(playerId);
    return s ? view(s) : null;
  };
  const same = (s, stamp) => stamp && s.sessionId === stamp.sessionId && s.runId === stamp.runId && s.revision === stamp.revision && s.tableKey === stamp.tableKey;

  function join(playerId, tableKey, { mode, confirmed = false, seed } = {}) {
    if (players.has(playerId)) return fail('already-seated');
    if (tables.has(tableKey)) return fail('table-busy');
    if (mode !== 'new' && mode !== 'resume') return fail('invalid-mode');
    const doc = store.load(playerId);
    if (!doc || doc.ok === false) return fail(doc?.reason ?? 'unavailable');
    let runId = doc.runId, state = doc.snapshot, revision = doc.revision;
    if (mode === 'new') {
      if (runId && !confirmed) return fail('confirm-replace');
      runId = makeRunId(playerId);
      state = createRun(seed);
      const saved = store.save(playerId, revision, runId, state, { replace:!!doc.runId });
      if (!saved.ok) return saved;
      revision = saved.revision;
    } else if (!runId || !state) return fail('no-run');
    const session = { playerId, tableKey, runId, state, revision, sessionId:++nextSession };
    players.set(playerId,session);
    tables.set(tableKey,playerId);
    return { ok:true, session:view(session) };
  }

  function leave(playerId, stamp) {
    const s = players.get(playerId);
    if (!s) return fail('not-seated');
    if (stamp && !same(s,stamp)) return fail('stale');
    tables.delete(s.tableKey);
    players.delete(playerId);
    return { ok:true };
  }

  function dispatch(playerId, stamp, action, elapsed = 0) {
    const s = players.get(playerId);
    if (!s) return fail('not-seated');
    if (!same(s,stamp)) return fail('stale');
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || (elapsed && action.type === 'tick')) return fail('invalid-clock');
    const clock = elapsed ? applyAction(s.state,{type:'tick',ticks:elapsed}) : null;
    const expired = !!clock && clock.state.phase !== s.state.phase;
    const output = expired ? clock : applyAction(clock?.state ?? s.state,action);
    if (!output) return fail('invalid-action');
    const saved = store.save(playerId,s.revision,s.runId,output.state);
    if (!saved.ok) return saved;
    s.state = output.state;
    s.revision = saved.revision;
    return { ok:true, session:view(s), events:output.events, actionApplied:!expired };
  }

  function finalize(playerId, stamp, displayName) {
    const s = players.get(playerId);
    if (!s) return fail('not-seated');
    if (!same(s,stamp)) return fail('stale');
    if (s.state.phase !== 'ended') return fail('not-ended');
    if (s.state.result !== 'cashout' && s.state.result !== 'lost') return fail('invalid-result');
    const score = s.state.result === 'cashout' ? s.state.score : null;
    const result = store.finalize(playerId,s.revision,s.runId,{score,displayName});
    if (result.ok) leave(playerId,stamp);
    return result;
  }

  return { current, owner: key => tables.get(key) ?? null, join, leave, dispatch, finalize };
}
