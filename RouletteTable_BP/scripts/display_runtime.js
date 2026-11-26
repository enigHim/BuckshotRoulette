import { tableToWorld, FELT_HEIGHT, pickRegion, stealSlot } from './probe_layout.js';

const TYPE = 'roulette_table:game_display';
const PREFIX = 'roulette_table:';
const items = ['magnifier','beer','cuffs','saw','cigarette','adrenaline','inverter','phone','expired'];
const HEALTH_SIDES = ['player','dealer'];
const HEALTH_FLASH_STEPS = 4;

function encodeShellPattern(shells) {
  if (!shells) return 0;
  const {live,blank} = shells;
  if (![live,blank].every(n=>Number.isInteger(n) && n >= 0 && n <= 4)) return 0;
  const pattern = shells.pattern === undefined
    ? [...Array(live).fill('live'),...Array(blank).fill('blank')]
    : shells.pattern;
  if (!Array.isArray(pattern) || pattern.length !== live+blank) return 0;
  let encoded = 0, liveCount = 0;
  for (const [i,shell] of pattern.entries()) {
    if (shell !== 'live' && shell !== 'blank') return 0;
    if (shell === 'live') liveCount++;
    encoded += (shell === 'live' ? 1 : 2)*3**i;
  }
  return liveCount === live ? encoded : 0;
}

function updateHealthFlash(entry, values) {
  const sameStage = entry.previous.stage === values.stage;
  for (const side of HEALTH_SIDES) {
    const hp = values[`hp_${side}`];
    const previousHp = entry.previous[`hp_${side}`];
    if (!sameStage || previousHp === undefined) delete entry.healthFlash[side];
    else if (previousHp !== hp) {
      // XOR the old and new lit ranges so doubled damage flashes both lost pips.
      entry.healthFlash[side] = {mask:((1<<previousHp)-1)^((1<<hp)-1),steps:HEALTH_FLASH_STEPS};
    }
    const flash = entry.healthFlash[side];
    values[`hp_flash_${side}`] = flash && flash.steps % 2 === 0 ? flash.mask : 0;
    // The runtime updates the display every five ticks. Two pulses take one second.
    if (flash && --flash.steps === 0) delete entry.healthFlash[side];
  }
}

export function displayValues(state, turn, local, scene) {
  const values = {};
  for (const [i, side] of ['player','dealer'].entries()) {
    for (let slot=0;slot<8;slot++) values[`slot${i*8+slot}`] = items.indexOf(state[side].items[slot])+1;
  }
  if (scene?.holdItem) values[`slot${scene.holdItem.slot}`] = items.indexOf(scene.holdItem.id)+1;
  const region = local && pickRegion(local.x,local.z);
  let hover = 0;
  if (region?.kind === 'slot' && region.side === 'player' && state.player.items[region.slot] &&
      ['playerTurn','itemSelected'].includes(state.phase)) hover = region.slot+1;
  const steal = stealSlot(state,local);
  if (steal !== null) hover = 9+steal;
  // The shotgun leaves the table while a shot is being lined up or taken.
  const aiming = ['aim','steal'].includes(state.phase);
  return {...values, hover,
    hp_player:state.player.hp, hp_dealer:state.dealer.hp, stage:scene?.stage ?? state.stage,
    gun:scene?.gun ?? (aiming ? 0 : state.sawActive ? 2 : 1), turn,
    box:state.phase === 'collect', player_cuffed:scene?.playerCuffed ?? (state.cuffed?.player === true),
    defib:scene?.defib === true, peek:scene?.peek === 'live' ? 2 : scene?.peek === 'blank' ? 1 : 0,
    shell_pattern:encodeShellPattern(scene?.shells),
    loose_shell:state.looseShell?.visible ? 1+state.looseShell.slot+(state.looseShell.shell === 'blank' ? 3 : 0) : 0,
    ...Object.fromEntries(Object.entries(scene?.hp ?? {}).map(([side,hp])=>[`hp_${side}`,hp]))};
}

export function createDisplayManager() {
  const active = new Map();
  const dealers = new Map();
  const DEALER = PREFIX+'dealer_display';
  function setDealerHidden(key, hidden) {
    const entry = dealers.get(key);
    if (!entry?.entity.isValid || entry.previous.hidden === hidden) return;
    entry.entity.setProperty(PREFIX+'hidden',hidden);
    entry.previous.hidden = hidden;
  }
  function updateDealer(table,state,scene) {
    let entry = dealers.get(table.key);
    if (!entry?.entity.isValid) {
      const center = tableToWorld(table,1.5,FELT_HEIGHT,.25);
      for (const old of table.dimension.getEntities({type:DEALER,location:center,maxDistance:.1})) old.remove();
      entry = {entity:table.dimension.spawnEntity(DEALER,center),previous:{}};
      dealers.set(table.key,entry);
    }
    setDealerHidden(table.key,scene?.hideDealer === true);
    for (const [key,value] of Object.entries({turn:table.turn,cuffed:state.cuffed?.dealer === true})) {
      if (entry.previous[key] === value) continue;
      entry.entity.setProperty(PREFIX+key,value);
      entry.previous[key] = value;
    }
  }
  function remove(key) {
    for (const group of [active,dealers]) {
      const entry = group.get(key);
      group.delete(key);
      try { if (entry?.entity.isValid) entry.entity.remove(); } catch (error) { console.warn(`Roulette display removal: ${error}`); }
    }
  }
  function update(table, state, local, scene) {
    updateDealer(table,state,scene);
    let entry = active.get(table.key);
    if (!entry?.entity.isValid) {
      const center = tableToWorld(table,1.5,FELT_HEIGHT,2);
      // Recover a saved entity after a server crash, without disturbing a nearby table.
      for (const old of table.dimension.getEntities({type:TYPE,location:center,maxDistance:.1})) old.remove();
      entry = { entity:table.dimension.spawnEntity(TYPE,center), previous:{}, healthFlash:{}, wait:1 };
      active.set(table.key,entry);
      return;
    }
    if (entry.wait > 0) { entry.wait--; return; }
    let budget = 5;
    const values = displayValues(state,table.turn,local,scene);
    updateHealthFlash(entry,values);
    const order = ['turn','stage','hp_player','hp_flash_player','hp_dealer','hp_flash_dealer',
      'gun',...(scene?.stolenSlot !== undefined ? [`slot${scene.stolenSlot}`] : []),
      'loose_shell','defib','peek','shell_pattern','hover'];
    const slots = Object.keys(values).filter(name=>name.startsWith('slot'));
    if (values.box) order.push('box');
    order.push(...slots);
    if (!values.box) order.push('box');
    for (const name of new Set([...order,...Object.keys(values)])) {
      const value = values[name];
      if (entry.previous[name] !== value) {
        entry.entity.setProperty(PREFIX+name,value);
        entry.previous[name] = value;
        if (--budget === 0) break;
      }
    }
  }
  function prune(dimension,location) {
    for (const [type,group] of [[TYPE,active],[DEALER,dealers]]) {
      const owned = new Set([...group.values()].map(e=>e.entity.id));
      for (const e of dimension.getEntities({type,location,maxDistance:32})) {
        if (!owned.has(e.id)) e.remove();
      }
    }
  }
  return {remove,update,prune,setDealerHidden};
}
