// Pure multiplayer reducer shared by all seated players.
export const MULTI_ITEM_NAMES = Object.freeze({
  magnifier:'放大镜', beer:'啤酒', gameMachine:'游戏机', saw:'手锯', cigarette:'香烟',
  adrenaline:'肾上腺素', inverter:'逆转器', phone:'一次性手机', expired:'过期药品',
});
const ITEMS = Object.keys(MULTI_ITEM_NAMES);
const SLOTS = 8;
const clone = value => JSON.parse(JSON.stringify(value));
const emit = (events,type,data={}) => events.push({type,...data});
const validSlot = slot => Number.isInteger(slot) && slot>=0 && slot<SLOTS;

function rand(s,n) {
  let x=s.rng>>>0; x^=x<<13; x^=x>>>17; x^=x<<5; s.rng=x>>>0;
  return Math.floor(s.rng/4294967296*n);
}
function alive(s) { return s.players.filter(p=>p.alive); }
function nextTurn(s, from, events) {
  let firstAlive=null;
  for(let step=1;step<=s.players.length;step++) {
    const i=(from+step)%s.players.length, p=s.players[i];
    if(!p.alive) continue;
    firstAlive ??= i;
    if(p.skip) { p.skip=false; emit(events,'skip',{who:p.id}); continue; }
    s.current=i; return true;
  }
  if(firstAlive!==null){s.current=firstAlive;return true;}
  return false;
}
function createLoad(s,events) {
  const count=2+rand(s,7), live=Math.floor(count/2);
  s.shells=Array.from({length:count},(_,i)=>i<live?'live':'blank');
  for(let i=count-1;i>0;i--){const j=rand(s,i+1);[s.shells[i],s.shells[j]]=[s.shells[j],s.shells[i]];}
  s.live=live;s.blank=count-live;s.loadNo++;s.sawActive=false;
  for(const p of s.players){
    p.known=Array(count).fill(null);
    let issued=0;
    while(issued<2){const slot=p.items.indexOf(null);if(slot<0)break;const id=ITEMS[rand(s,ITEMS.length)];p.items[slot]=id;issued++;emit(events,'itemGranted',{to:p.id,id,slot});}
  }
  s.phase='turn';
  if(!s.players[s.current]?.alive && !nextTurn(s,s.current-1,events)) s.phase='ended';
  emit(events,'load',{live,blank:s.blank,loadNo:s.loadNo,first:s.players[s.current]?.id});
}
export function createMultiplayerRun(ids,seed=1) {
  if(!Array.isArray(ids)||ids.length<2||ids.length>4||new Set(ids).size!==ids.length)throw Error('invalid players');
  const first=(seed>>>0)%ids.length;
  return {schemaVersion:1,mode:'multiplayer',players:ids.map((id,seat)=>({id,seat,hp:3,maxHp:3,items:Array(SLOTS).fill(null),known:[],skip:false,sawActive:false,alive:true,departed:false})),shells:[],current:first,first,phase:'load',rng:(seed>>>0)||1,round:1,scores:Object.fromEntries(ids.map(id=>[id,0])),loadNo:0,live:0,blank:0,result:null};
}
function useItem(s,action,events) {
  const player=s.players[s.current], slot=action.slot;
  if(!validSlot(slot)||!player.items[slot])return false;
  const id=player.items[slot], target=s.players.find(p=>p.id===action.target);
  if(id==='gameMachine'){
    if(!target||!target.alive||target.id===player.id)return false;
    target.skip=true; player.items[slot]=null; emit(events,'itemUsed',{by:player.id,id,target:target.id}); return true;
  }
  if(id==='adrenaline'){
    const victim=target;
    if(!victim?.alive||victim.id===player.id||!validSlot(action.stealSlot)||!victim.items[action.stealSlot])return false;
    const stolen=victim.items[action.stealSlot];
    if((stolen==='inverter'||stolen==='beer')&&!s.shells.length)return false;
    victim.items[action.stealSlot]=null; player.items[slot]=null;
    emit(events,'steal',{by:player.id,from:victim.id,id:stolen,slot:action.stealSlot});
    return applyEffect(s,player,stolen,action.target,events);
  }
  if((id==='inverter'||id==='beer')&&!s.shells.length)return false;
  player.items[slot]=null;
  return applyEffect(s,player,id,action.target,events);
}
function applyEffect(s,player,id,targetId,events) {
  switch(id){
    case 'gameMachine': {const t=s.players.find(p=>p.id===targetId);if(!t?.alive||t.id===player.id)return false;t.skip=true;break;}
    case 'inverter': if(!s.shells.length)return false; s.shells[0]=s.shells[0]==='live'?'blank':'live';s.live=s.shells.filter(x=>x==='live').length;s.blank=s.shells.length-s.live;player.known[0]=s.shells[0];break;
    case 'beer': if(!s.shells.length)return false; {const shell=s.shells.shift();s.live=s.shells.filter(x=>x==='live').length;s.blank=s.shells.length-s.live;emit(events,'eject',{by:player.id,shell});if(!s.shells.length){s.phase='load';createLoad(s,events);}}break;
    case 'magnifier': if(s.shells.length)player.known[0]=s.shells[0];break;
    case 'phone': if(s.shells.length>1){const i=1+rand(s,s.shells.length-1);player.known[i]=s.shells[i];emit(events,'peek',{by:player.id,index:i,shell:s.shells[i]});}break;
    case 'saw': player.sawActive=true;break;
    case 'cigarette': player.hp=Math.min(player.maxHp,player.hp+1);emit(events,'hp',{who:player.id,hp:player.hp});break;
    case 'expired': {const delta=rand(s,2)?-1:2;player.hp=Math.max(0,Math.min(player.maxHp,player.hp+delta));emit(events,'hp',{who:player.id,hp:player.hp});if(!player.hp){player.alive=false;emit(events,'dead',{who:player.id});}}break;
  }
  emit(events,'itemUsed',{by:player.id,id,target:targetId});return true;
}
function finishIfNeeded(s,events) {
  const survivors=alive(s);
  if(survivors.length>1)return false;
  const winner=survivors[0]?.id??null;
  const departed=s.players.some(p=>p.departed);
  if(!winner&&!departed){
    for(const p of s.players){p.hp=p.maxHp;p.alive=true;p.items=Array(SLOTS).fill(null);p.skip=false;p.sawActive=false;p.known=[];}
    s.shells=[];s.live=0;s.blank=0;s.phase='load';
    emit(events,'drawRetry',{round:s.round,suddenDeath:!!s.suddenDeath});
    return true;
  }
  emit(events,'roundEnd',{round:s.round,winner});
  if(winner)s.scores[winner]=(s.scores[winner]??0)+1;
  const active=s.players.filter(p=>!p.departed);
  const top=Math.max(0,...active.map(p=>s.scores[p.id]??0));
  if(top>=2||active.length<=1){
    s.phase='ended';
    s.winner=active.sort((a,b)=>(s.scores[b.id]??0)-(s.scores[a.id]??0))[0]?.id??null;
    s.result='matchEnd'; emit(events,'matchEnd',{winner:s.winner,scores:{...s.scores}}); return true;
  }
  if(s.round>=3){
    const leaders=active.filter(p=>(s.scores[p.id]??0)===top);
    if(leaders.length===1){
      s.phase='ended';s.winner=leaders[0].id;s.result='matchEnd';
      emit(events,'matchEnd',{winner:s.winner,scores:{...s.scores}});return true;
    }
    if(!s.suddenDeath){
      s.suddenDeath=true;
      for(const p of s.players){p.maxHp=2;p.hp=2;p.alive=!p.departed;p.items=Array(SLOTS).fill(null);p.skip=false;p.sawActive=false;p.known=[];}
      s.shells=[];s.live=0;s.blank=0;s.phase='load';emit(events,'suddenDeath',{round:s.round});return true;
    }
  }
  s.round++;
  for(const p of s.players){p.maxHp=3;p.hp=3;p.alive=!p.departed;p.items=Array(SLOTS).fill(null);p.skip=false;p.sawActive=false;p.known=[];}
  s.shells=[];s.live=0;s.blank=0;
  s.first=(s.first+1)%s.players.length;s.current=s.first;s.phase='load';
  emit(events,'nextRound',{round:s.round,first:s.players[s.first].id});
  return true;
}
export function applyMultiplayerAction(state,action) {
  if(!state||!action||state.phase==='ended')return null;
  const s=clone(state),events=[];
  if(action.type==='aim') { if(s.phase!=='turn')return null; s.phase='aim'; emit(events,'aim',{by:s.players[s.current].id}); return {state:s,events}; }
  if(action.type==='playerLeft'){
    const i=s.players.findIndex(p=>p.id===action.playerId);
    if(i<0||!s.players[i].alive)return null;
    s.players[i].alive=false;s.players[i].hp=0;s.players[i].departed=true;emit(events,'dead',{who:action.playerId,left:true});
    if(finishIfNeeded(s,events))return {state:s,events};
    if(i===s.current){if(s.phase==='aim')s.phase='turn';const ok=nextTurn(s,i,events);if(!ok)s.phase='ended';finishIfNeeded(s,events);}
    return {state:s,events};
  }
  if(s.phase==='load'){
    if(action.type!=='advance')return null;
    createLoad(s,events);return {state:s,events};
  }
  if(action.type==='shoot') {
    if(s.phase!=='aim')return null;
  } else if(s.phase!=='turn') return null;
  const player=s.players[s.current];if(!player?.alive)return null;
  if(action.type==='useItem'){
    if(s.phase!=='turn'||!useItem(s,action,events))return null;
    finishIfNeeded(s,events);return {state:s,events};
  }
  if(action.type!=='shoot')return null;
  const target=s.players.find(p=>p.id===action.target);if(!target?.alive)return null;
  if(!s.shells.length){s.phase='load';createLoad(s,events);return {state:s,events};}
  const shell=s.shells.shift(),damage=shell==='live'?(player.sawActive?2:1):0;player.sawActive=false;
  if(damage){target.hp=Math.max(0,target.hp-damage);if(!target.hp){target.alive=false;emit(events,'dead',{who:target.id});}}
  s.live=s.shells.filter(x=>x==='live').length;s.blank=s.shells.length-s.live;
  emit(events,'shot',{by:player.id,to:target.id,shell,damage,hp:Object.fromEntries(s.players.map(p=>[p.id,p.hp]))});
  if(finishIfNeeded(s,events))return {state:s,events};
  if(!s.shells.length){s.phase='load';emit(events,'empty');return {state:s,events};}
  const shooterIndex=s.current;
  s.phase='turn';
  if(!(target.id===player.id&&shell==='blank')) {
    let from=shooterIndex;
    for(let step=0;step<s.players.length;step++) {
      const candidate=(from+1)%s.players.length, next=s.players[candidate];
      if(!next.alive) { from=candidate; continue; }
      if(next.skip) { next.skip=false; emit(events,'skip',{who:next.id}); from=candidate; continue; }
      s.current=candidate; break;
    }
  }
  finishIfNeeded(s,events);
  return {state:s,events};
}
export function validateMultiplayerSnapshot(s) {
  return !!s&&s.mode==='multiplayer'&&Array.isArray(s.players)&&s.players.length>=2&&s.players.length<=4&&
    s.players.every(p=>typeof p.id==='string'&&Number.isInteger(p.hp)&&p.hp>=0&&p.hp<=p.maxHp&&Array.isArray(p.items)&&p.items.length===SLOTS&&p.items.every(v=>v===null||ITEMS.includes(v)));
}
