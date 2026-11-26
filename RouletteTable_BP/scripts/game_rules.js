// Pure, JSON-serializable endless-mode reducer. Only trusted server code may
// supply actions: shells, RNG, pending items and knowledge are private state.
export const ITEM_NAMES = Object.freeze({magnifier:'放大镜', beer:'啤酒', cuffs:'手铐', saw:'手锯',
  cigarette:'香烟', adrenaline:'肾上腺素', inverter:'逆转器', phone:'一次性手机', expired:'过期药品'});
const ITEMS = Object.keys(ITEM_NAMES);
const SIDES = ['player','dealer'];
const SLOTS = 8;
const STEAL_TICKS = 200;
const other = who => who === 'player' ? 'dealer' : 'player';
const empty = () => Array(SLOTS).fill(null);
const actionsIn = (s, ...phases) => phases.includes(s.phase);
const validSlot = n => Number.isInteger(n) && n >= 0 && n < SLOTS;
const validTarget = target => target === 'self' || target === 'opponent';
const toggle = value => value === 'live' ? 'blank' : 'live';

// Draft policy. A side may hold at most HOLD_CAPS copies of a kind, and the saw
// needs a stage wide enough that a doubled shot cannot end it instantly. Weights
// only shape the mix; they never override a cap.
const HOLD_CAPS = Object.freeze({magnifier:2, beer:2, cuffs:1, saw:1, cigarette:1,
  adrenaline:1, inverter:1, phone:1, expired:1});
const DRAFT_WEIGHT = Object.freeze({magnifier:3, beer:2, cuffs:2, saw:2, cigarette:2,
  inverter:1, phone:1, expired:1, adrenaline:1});

function stagePool(s) {
  return ITEMS.filter(id => id !== 'saw' || s.maxHp >= 3);
}

/** Weighted draw without replacement for one side, counting what it already holds. */
function draftFor(s, side, count, pool) {
  const held = {};
  for (const id of side.items) if (id) held[id] = (held[id] || 0) + 1;
  const picks = [];
  for (let k=0;k<count;k++) {
    const legal = pool.filter(id => (held[id] || 0) < HOLD_CAPS[id]);
    if (!legal.length) break;
    let roll = rand(s, legal.reduce((sum,id) => sum + DRAFT_WEIGHT[id], 0));
    let chosen = legal[legal.length-1];
    for (const id of legal) {
      roll -= DRAFT_WEIGHT[id];
      if (roll < 0) { chosen = id; break; }
    }
    picks.push(chosen);
    held[chosen] = (held[chosen] || 0) + 1;
  }
  return picks;
}

function rand(s, count) {
  let x = s.rng;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  s.rng = x >>> 0;
  return Math.floor(s.rng / 4294967296 * count);
}

function turn(s, who) {
  s.actor = who;
  s.phase = who === 'player' ? 'playerTurn' : 'dealerTurn';
  s.selectedSlot = null;
  s.stealTicks = 0;
}

function load(s, events) {
  const n = 2 + rand(s,7);
  const live = Math.floor(n/2);
  s.shells = Array.from({length:n}, (_, i) => i < live ? 'live' : 'blank');
  for (let i=n-1;i>0;i--) {
    const j=rand(s,i+1);
    [s.shells[i],s.shells[j]]=[s.shells[j],s.shells[i]];
  }
  const pool = stagePool(s);
  s.loadNo++;
  s.live = s.liveLeft = live;
  s.blank = n-live;
  s.queue = [];
  s.collectIndex = 0;
  s.sawActive = false;
  for (const who of SIDES) {
    const side = s[who];
    side.known = Array(n).fill(null);
    s.cuffed[who] = false;
    const open = [];
    for (let slot=0;slot<SLOTS;slot++) if (side.items[slot] === null) open.push(slot);
    const picks = draftFor(s, side, Math.min(open.length, s.itemsPerLoad), pool);
    picks.forEach((id, i) => s.queue.push({who, slot:open[i], id}));
  }
  turn(s,'player');
  s.phase = 'loadReveal';
  // Composition only; order never leaves server-side state.
  events.push({type:'loadReveal',live:s.live,blank:s.blank,loadNo:s.loadNo});
}

function finishCollect(s, events) {
  for (const {who,slot,id} of s.queue.slice(s.collectIndex)) {
    s[who].items[slot]=id;
    events.push({type:'collected',who,slot,id});
  }
  s.queue=[];
  s.collectIndex=0;
  if (s.looseShell) s.looseShell.visible=false;
  turn(s,'player');
}

function setupStage(s, events) {
  s.maxHp=2+rand(s,3);
  s.itemsPerLoad=2+rand(s,4);
  s.loadNo=0;
  for (const who of SIDES) {
    s[who].hp=s.maxHp;
    s[who].items=empty();
  }
  events.push({type:'stageStart',group:s.group,stage:s.stage,maxHp:s.maxHp});
  load(s,events);
}

/** createRun(uint32 seed) returns the initial `loadReveal` state. Initial reveal
 * counts are state.live/state.blank; later reveals also emit an event. */
export function createRun(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be uint32');
  const s={ schemaVersion:1, revision:0, rng:seed || 0x729af313, group:1, stage:1,
    player:{hp:0,items:[],known:[]}, dealer:{hp:0,items:[],known:[]},
    cuffed:{player:false,dealer:false}, elapsedTicks:0, score:'0', result:null };
  setupStage(s,[]);
  return s;
}

function twice(value) {
  let carry=0, result='';
  for (let i=value.length-1;i>=0;i--) {
    const n=2*(value.charCodeAt(i)-48)+carry;
    result=(n%10)+result;
    carry=Math.floor(n/10);
  }
  return carry ? carry+result : result;
}

function death(s, who, events) {
  events.push({type:'dead',who});
  if (who === 'player') {
    s.phase='ended';
    s.score='0';
    s.result='lost';
    events.push({type:'end',result:s.result,score:s.score});
  } else if (s.stage < 3) {
    s.stage++;
    setupStage(s,events);
  } else {
    s.score=s.group===1 ? String(Math.max(10,70000-Math.floor(s.elapsedTicks*10/3))) : twice(s.score);
    s.phase='double';
    events.push({type:'setClear',group:s.group,score:s.score});
  }
}

function pull(s) {
  const shell=s.shells.shift();
  for (const who of SIDES) s[who].known.shift();
  if (shell === 'live') s.liveLeft--;
  return shell;
}

function fire(s, target, events) {
  const by=s.actor;
  const to=target === 'self' ? by : other(by);
  const shell=pull(s);
  const damage=shell==='blank' ? 0 : s.sawActive ? 2 : 1;
  s.sawActive=false;
  s[to].hp=Math.max(0,s[to].hp-damage);
  // Use a display-only draw so the shell marker never advances gameplay RNG.
  const roll = (Math.imul(s.revision+1,0x9e3779b1) ^ s.rng) >>> 0;
  const spots = [0,1,2].filter(slot=>slot !== s.looseShell?.slot);
  s.looseShell = {slot:spots[roll % spots.length],shell,visible:true};
  events.push({type:'shot',by,to,shell,damage,hp:{player:s.player.hp,dealer:s.dealer.hp}});
  if (s[to].hp === 0) { death(s,to,events); return; }
  if (s.shells.length === 0) { load(s,events); return; }
  let next = target === 'self' && shell === 'blank' ? by : other(by);
  while (s.cuffed[next]) {
    s.cuffed[next]=false;
    events.push({type:'skip',who:next});
    next=other(next);
  }
  turn(s,next);
}

function applyItem(s, who, id, events) {
  const side=s[who];
  const emit=(type, fields={}) => events.push({type,by:who,...fields});
  switch(id) {
    case 'magnifier':
      side.known[0]=s.shells[0];
      emit('peek',{shell:s.shells[0],privateTo:who});
      break;
    case 'beer': {
      const shell=pull(s);
      emit('eject',{shell,left:s.shells.length});
      if (!s.shells.length) load(s,events);
      break;
    }
    case 'cuffs':
      s.cuffed[other(who)]=true;
      emit('cuffs',{on:other(who)});
      break;
    case 'saw': s.sawActive=true; emit('saw'); break;
    case 'cigarette':
      side.hp=Math.min(s.maxHp,side.hp+1);
      emit('hp',{id,hp:side.hp});
      break;
    case 'expired': {
      const lucky=rand(s,2)===0;
      side.hp=Math.max(0,Math.min(s.maxHp,side.hp+(lucky?2:-1)));
      emit('hp',{id,hp:side.hp,lucky});
      if (!side.hp) death(s,who,events);
      break;
    }
    case 'inverter': {
      const next=toggle(s.shells[0]);
      s.shells[0]=next;
      s.liveLeft+=next==='live'?1:-1;
      // The side that flipped it knows the new top shell; an opponent only keeps
      // knowledge it already had, so the flip never reveals anything for free.
      for (const k of SIDES) if (s[k].known[0]!==null) s[k].known[0]=next;
      side.known[0]=next;
      emit('invert');
      break;
    }
    case 'phone': {
      const index=s.shells.length>1 ? 1+rand(s,s.shells.length-1) : -1;
      if (index !== -1) side.known[index]=s.shells[index];
      emit('peekAt',{index,shell:index===-1?null:s.shells[index],privateTo:who});
      break;
    }
  }
}

function canSteal(side, slot) {
  return validSlot(slot) && side.items[slot] !== null && side.items[slot] !== 'adrenaline';
}

function takeItem(s, who, slot, events) {
  const id=s[who].items[slot];
  s[who].items[slot]=null;
  events.push({type:'itemUsed',by:who,id,slot});
  return id;
}

function steal(s, who, slot, events) {
  const foe=other(who);
  const id=s[foe].items[slot];
  s[foe].items[slot]=null;
  events.push({type:'steal',by:who,from:foe,id,slot});
  applyItem(s,who,id,events);
}

/** Immutable reducer. Invalid actions return null. Player action phase map:
 * loadReveal advance; collect collect; playerTurn useItem(slot), aim;
 * itemSelected selectItem(slot) (same slot cancels), cancelItem, useItem;
 * aim shoot(target); steal steal(slot); double double(yes). Tick(ticks) supplies
 * elapsed active server ticks (20/s), never wall-clock or animation callbacks.
 * Timer-only ticks preserve revision; phase changes always increment it.
 * DealerTurn accepts only dealerAction(state)'s move. Events use `type` and
 * replay signals for presentation only; never apply their effects a second time.
 */
export function applyAction(state, action) {
  if (!state || !action || state.phase==='ended') return null;
  const s=JSON.parse(JSON.stringify(state));
  const events=[];
  const slot=action.slot;
  switch(action.type) {
    case 'tick': {
      const n=action.ticks;
      if (!Number.isSafeInteger(n) || n<=0) return null;
      const clock=s.group===1 && s.phase!=='double';
      if (!clock && s.phase!=='steal') return null;
      if (clock) s.elapsedTicks=Math.min(20997,s.elapsedTicks+n);
      if (s.phase==='steal') {
        s.stealTicks=Math.max(0,s.stealTicks-n);
        if (!s.stealTicks) { turn(s,'player'); events.push({type:'stealTimeout'}); }
      }
      break;
    }
    case 'advance':
      if (!actionsIn(s,'loadReveal')) return null;
      if (s.queue[0]?.who==='player') s.phase='collect';
      else finishCollect(s,events);
      break;
    case 'collect': {
      if (!actionsIn(s,'collect') || s.queue[s.collectIndex]?.who!=='player') return null;
      const {who,slot,id}=s.queue[s.collectIndex++];
      s.player.items[slot]=id;
      events.push({type:'collected',who,slot,id});
      if (s.queue[s.collectIndex]?.who!=='player') {
        finishCollect(s,events);
        events.push({type:'boxClosed'});
      }
      break;
    }
    case 'selectItem':
      if (!actionsIn(s,'playerTurn','itemSelected') || !validSlot(slot) || s.player.items[slot]===null) return null;
      if (s.selectedSlot===slot) turn(s,'player');
      else { s.phase='itemSelected'; s.selectedSlot=slot; }
      break;
    case 'cancelItem':
      if (!actionsIn(s,'itemSelected')) return null;
      turn(s,'player');
      break;
    case 'useItem': {
      if (!actionsIn(s,'playerTurn','itemSelected')) return null;
      const itemSlot = slot ?? (s.phase === 'itemSelected' ? s.selectedSlot : null);
      if (!validSlot(itemSlot) || s.player.items[itemSlot] === null) return null;
      const id=takeItem(s,'player',itemSlot,events);
      turn(s,'player');
      if (id==='adrenaline') {
        if (s.dealer.items.some((_,i)=>canSteal(s.dealer,i))) {
          s.phase='steal'; s.stealTicks=STEAL_TICKS;
          events.push({type:'stealPrompt',ticks:STEAL_TICKS});
        } else events.push({type:'stealUnavailable'});
      } else applyItem(s,'player',id,events);
      break;
    }
    case 'steal':
      if (!actionsIn(s,'steal') || !canSteal(s.dealer,slot)) return null;
      turn(s,'player');
      steal(s,'player',slot,events);
      break;
    case 'aim':
      if (!actionsIn(s,'playerTurn','itemSelected')) return null;
      s.selectedSlot=null;
      s.phase='aim';
      break;
    case 'shoot':
      if (!actionsIn(s,'aim') || !validTarget(action.target)) return null;
      fire(s,action.target,events);
      break;
    case 'dealer': {
      const expected=dealerAction(s);
      if (!expected || expected.move!==action.move || expected.target!==action.target ||
          expected.slot!==slot || expected.stealSlot!==action.stealSlot) return null;
      if (action.move==='shoot') fire(s,action.target,events);
      else {
        const id=takeItem(s,'dealer',slot,events);
        if (id==='adrenaline') steal(s,'dealer',action.stealSlot,events);
        else applyItem(s,'dealer',id,events);
      }
      break;
    }
    case 'double':
      if (!actionsIn(s,'double') || typeof action.yes!=='boolean') return null;
      if (action.yes) { s.group++; s.stage=1; setupStage(s,events); }
      else { s.phase='ended'; s.result='cashout'; events.push({type:'end',result:s.result,score:s.score}); }
      break;
    default: return null;
  }
  if (action.type!=='tick' || s.phase!==state.phase) s.revision++;
  return {state:s,events};
}

const PHASES = ['loadReveal','collect','playerTurn','itemSelected','aim','steal','dealerTurn','double','ended'];
const integer = (n, min, max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
const isShell = v => v === 'live' || v === 'blank';

/** Validate untrusted JSON before restoring a session. Does not modify it. */
export function validateSnapshot(s) {
  if (!s || s.schemaVersion!==1 || !PHASES.includes(s.phase) || !integer(s.revision,0) ||
      !integer(s.rng,1,0xffffffff) || !integer(s.group,1) || !integer(s.stage,1,3) ||
      !integer(s.maxHp,2,4) || !integer(s.itemsPerLoad,2,5) || !integer(s.loadNo,1) ||
      !integer(s.elapsedTicks,0,20997) || typeof s.score!=='string' || !/^(0|[1-9][0-9]*)$/.test(s.score) ||
      !Array.isArray(s.shells) || s.shells.length>8 || !s.shells.every(isShell) ||
      !integer(s.live,1,4) || !integer(s.blank,1,4) || s.live!==Math.floor((s.live+s.blank)/2) ||
      s.shells.length>s.live+s.blank || s.liveLeft!==s.shells.filter(x=>x==='live').length ||
      typeof s.sawActive!=='boolean' || !SIDES.includes(s.actor) || !s.cuffed ||
      !Array.isArray(s.queue) || !integer(s.collectIndex,0,s.queue.length) ||
      !integer(s.stealTicks,0,STEAL_TICKS)) return false;
  if (s.looseShell !== undefined && (!s.looseShell || !integer(s.looseShell.slot,0,2) ||
      !isShell(s.looseShell.shell) || typeof s.looseShell.visible !== 'boolean')) return false;
  for (const who of SIDES) {
    const side=s[who];
    if (!side || !integer(side.hp,0,s.maxHp) || typeof s.cuffed[who]!=='boolean' ||
        !Array.isArray(side.items) || side.items.length!==SLOTS ||
        !side.items.every(v=>v===null || ITEMS.includes(v)) || !Array.isArray(side.known) ||
        side.known.length!==s.shells.length || !side.known.every((v,i)=>v===null || v===s.shells[i])) return false;
  }
  if (s.phase==='ended') {
    if (s.result==='lost') return s.player.hp===0 && s.dealer.hp>0 && s.score==='0';
    return s.result==='cashout' && s.stage===3 && s.dealer.hp===0 && s.player.hp>0 && s.score!=='0';
  }
  if (s.result!==null || s.player.hp===0) return false;
  if (s.phase==='double') return s.stage===3 && s.dealer.hp===0 && s.score!=='0';
  if (s.dealer.hp===0 || s.shells.length===0 || (s.phase==='dealerTurn')!==(s.actor==='dealer')) return false;
  if (s.phase==='itemSelected') {
    if (!validSlot(s.selectedSlot) || s.player.items[s.selectedSlot]===null) return false;
  } else if (s.selectedSlot!==null) return false;
  if (s.phase==='steal') {
    if (s.stealTicks===0 || !s.dealer.items.some((_,i)=>canSteal(s.dealer,i))) return false;
  } else if (s.stealTicks!==0) return false;
  if (s.phase==='loadReveal' && s.collectIndex!==0) return false;
  if (s.phase==='collect' && s.queue[s.collectIndex]?.who!=='player') return false;
  if (s.phase!=='collect' && s.phase!=='loadReveal') return s.queue.length===0 && s.collectIndex===0;
  const seen=new Set();
  let reachedDealer=false;
  for (let i=0;i<s.queue.length;i++) {
    const entry=s.queue[i];
    if (!entry || !SIDES.includes(entry.who) || !validSlot(entry.slot) || !ITEMS.includes(entry.id)) return false;
    const {who,slot,id}=entry, key=`${who}:${slot}`;
    if (who==='dealer') reachedDealer=true;
    else if (reachedDealer) return false;
    if (seen.has(key) || s[who].items[slot] !== (i<s.collectIndex?id:null)) return false;
    seen.add(key);
  }
  return true;
}

/** What the dealer may legitimately believe about the next shell. Only its own
 * peeks and information every player can see (remaining counts) are used, so the
 * action never leaks the hidden order. */
export function dealerRead(s) {
  const known = s.dealer.known[0];
  if (known === 'live' || known === 'blank') return known;
  const shells = s.shells.length;
  if (!shells) return null;
  if (s.liveLeft === 0) return 'blank';
  if (s.liveLeft === shells) return 'live';
  return null;
}

/** Expected-value shot choice when the next shell is not certain. */
export function dealerShot(s, read) {
  if (read === 'live') return 'opponent';
  if (read === 'blank') return 'self';
  const hurt = s.sawActive ? 2 : 1;
  // A fragile dealer does not gamble its own health on a free turn.
  if (s.dealer.hp <= hurt) return 'opponent';
  return s.liveLeft / s.shells.length > .5 ? 'opponent' : 'self';
}

export function dealerAction(s) {
  if (!s || s.phase!=='dealerTurn' || s.shells.length===0) return null;
  const {dealer}=s;
  const shells=s.shells.length;
  const slotOf=id=>dealer.items.indexOf(id);
  const has=id=>slotOf(id)>=0;
  const use=(id, stealSlot)=>({type:'dealer',move:'useItem',slot:slotOf(id),
    ...(stealSlot===undefined?{}:{stealSlot})});
  const shoot=target=>({type:'dealer',move:'shoot',target});
  const read=dealerRead(s);
  const sawSlot=slotOf('saw');
  const canSaw=sawSlot>=0 && !s.sawActive && s.maxHp>=3;

  // 1. Stay alive and top up while it is free to do so.
  if (has('cigarette') && dealer.hp<s.maxHp) return use('cigarette');
  if (has('expired') && dealer.hp>=3 && dealer.hp<s.maxHp) return use('expired');

  // 2. A certain shell decides the whole turn.
  if (read==='live') {
    if (canSaw && s.player.hp>1) return use('saw');
    return shoot('opponent');
  }
  if (read==='blank') {
    // Turn a free blank into a finisher when the player is one hit from death.
    if (has('inverter') && s.player.hp<=1) return use('inverter');
    return shoot('self');
  }

  // 3. Unknown: buy information and deny the player a turn before gambling.
  if (has('cuffs') && !s.cuffed.player) return use('cuffs');
  if (has('magnifier') && dealer.known[0]===null) return use('magnifier');
  if (has('phone') && shells>2) return use('phone');
  if (has('beer') && shells>2 && s.liveLeft>0 && s.liveLeft<shells) return use('beer');
  if (canSaw && s.liveLeft/shells>.6 && s.player.hp>1) return use('saw');
  if (has('adrenaline')) {
    // Take a tool the dealer is missing; stealing a duplicate is pointless.
    for (const id of ['inverter','saw','magnifier','cigarette','cuffs','beer','phone','expired']) {
      if (has(id)) continue;
      const target=s.player.items.indexOf(id);
      if (target>=0) return use('adrenaline',target);
    }
  }
  return shoot(dealerShot(s,read));
}
