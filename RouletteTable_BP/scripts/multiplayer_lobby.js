// In-memory multiplayer lobby coordinator. Gameplay state is attached only after the host starts.
const SEATS = Object.freeze(['south','north','east','west']);
const fail = reason => ({ok:false, reason});

export function createMultiplayerLobby({now = () => Date.now(), lockMs = 30_000} = {}) {
  const tables = new Map();
  const byPlayer = new Map();
  let sequence = 0;

  const table = key => tables.get(key);
  const view = t => ({
    tableKey:t.tableKey, hostId:t.hostId, started:t.started,
    seats:Object.fromEntries(SEATS.map(seat => [seat, t.seats.get(seat)?.playerId ?? null])),
    lock:t.lock ? {playerId:t.lock.playerId, expiresAt:t.lock.expiresAt, route:t.lock.route} : null,
  });
  const releaseExpired = t => {
    if (t.lock && now() >= t.lock.expiresAt) t.lock = null;
  };
  const touch = (tableKey, playerId, route) => {
    const t = table(tableKey);
    if (!t) return fail('table-missing');
    releaseExpired(t);
    if (!t.lock || t.lock.playerId !== playerId) return fail('form-lock');
    t.lock.expiresAt = now() + lockMs;
    t.lock.route = route;
    return {ok:true, expiresAt:t.lock.expiresAt};
  };

  function ensure(tableKey) {
    if (!tables.has(tableKey)) tables.set(tableKey, {tableKey, hostId:null, seats:new Map(), started:false, lock:null});
    return view(tables.get(tableKey));
  }
  function lockValid(tableKey, playerId, token) {
    const t = table(tableKey);
    if (!t) return false;
    releaseExpired(t);
    return !!t.lock && t.lock.playerId === playerId && t.lock.token === token;
  }
  function acquire(tableKey, playerId, route = 'lobby') {
    const t = table(tableKey);
    if (!t) return fail('table-missing');
    releaseExpired(t);
    if (t.lock && t.lock.playerId !== playerId) return fail('form-lock');
    t.lock = {playerId, route, expiresAt:now() + lockMs, token:++sequence};
    return {ok:true, token:t.lock.token, expiresAt:t.lock.expiresAt};
  }

  function release(tableKey, playerId, token) {
    const t = table(tableKey);
    if (!t) return fail('table-missing');
    releaseExpired(t);
    if (!t.lock) return {ok:true};
    if (t.lock.playerId !== playerId || (token !== undefined && token !== t.lock.token)) return fail('form-lock');
    t.lock = null;
    return {ok:true};
  }

  function enter(tableKey, playerId, seat) {
    if (!SEATS.includes(seat)) return fail('invalid-seat');
    const t = tables.get(tableKey);
    if (!t) tables.set(tableKey, {tableKey, hostId:null, seats:new Map(), started:false, lock:null});
    const current = tables.get(tableKey);
    if (current.started) return fail('started');
    if (byPlayer.has(playerId)) return fail('already-seated');
    if (current.seats.has(seat)) return fail('seat-busy');
    const entry = {playerId, seat, joinedAt:now(), order:++sequence};
    current.seats.set(seat, entry);
    byPlayer.set(playerId, {tableKey, seat});
    if (!current.hostId) current.hostId = playerId;
    return {ok:true, lobby:view(current), host:current.hostId === playerId};
  }

  function addBot(tableKey, playerId) {
    const t=tables.get(tableKey);
    if(!t)return fail('table-missing');
    if(t.started)return fail('started');
    if(t.hostId!==playerId)return fail('not-host');
    const seat=SEATS.find(key=>!t.seats.has(key));
    if(!seat)return fail('full');
    const botId=`bot:${tableKey}:${seat}`;
    const entry={playerId:botId,seat,joinedAt:now(),order:++sequence,isBot:true};
    t.seats.set(seat,entry);
    return {ok:true,seat,botId,lobby:view(t)};
  }

  function leave(tableKey, playerId) {
    const t = tables.get(tableKey);
    if (!t) return fail('table-missing');
    const pos = byPlayer.get(playerId);
    if (!pos || pos.tableKey !== tableKey) return fail('not-seated');
    t.seats.delete(pos.seat);
    byPlayer.delete(playerId);
    if (t.lock?.playerId === playerId) t.lock = null;
    if (t.hostId === playerId) t.hostId = [...t.seats.values()].sort((a,b)=>a.order-b.order)[0]?.playerId ?? null;
    if (!t.seats.size && !t.started) { t.lock = null; tables.delete(tableKey); }
    return {ok:true, lobby:tables.has(tableKey) ? view(t) : null};
  }

  function start(tableKey, playerId) {
    const t = tables.get(tableKey);
    if (!t) return fail('table-missing');
    if (t.hostId !== playerId) return fail('not-host');
    if (t.seats.size < 2) return fail('need-two');
    releaseExpired(t);
    if (t.lock && t.lock.playerId !== playerId) return fail('form-lock');
    t.started = true;
    t.lock = null;
    return {ok:true, lobby:view(t)};
  }

  function getPlayer(playerId) { return byPlayer.get(playerId) ?? null; }
  function get(tableKey) { const t=tables.get(tableKey); if (!t) return null; releaseExpired(t); return view(t); }
  function players(tableKey) {
    const t = tables.get(tableKey);
    return t ? [...t.seats.values()].sort((a,b)=>a.order-b.order).map(entry=>({playerId:entry.playerId,seat:entry.seat})) : [];
  }
  function tick() { for (const t of tables.values()) releaseExpired(t); }

  return {SEATS, ensure, acquire, release, touch, lockValid, enter, addBot, leave, start, getPlayer, players, get, tick};
}
