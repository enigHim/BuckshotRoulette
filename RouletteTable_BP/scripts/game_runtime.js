import { InputPermissionCategory, system, world } from '@minecraft/server';
import { ActionFormData, MessageFormData } from '@minecraft/server-ui';
import { tableAt, seatAt, multiSeatAt, seatIssue, tableIntact, tableToWorld, worldToTable, feltHit, pickRegion, aimRegion, stealSlot, STEAL_ADVANCE, rotate } from './probe_layout.js';
import { createRun, applyAction, dealerAction, ITEM_NAMES, validateSnapshot } from './game_rules.js';
import { createGameStore } from './game_store.js';
import { createSessions } from './game_sessions.js';
import { phaseMenu, itemMenu, eventText, statusText } from './game_menu.js';
import { createDisplayManager } from './display_runtime.js';
import { cameraPlan, playStep, setFreeCamera, ammoReveal, DEFIB_CUE_TICKS } from './game_cameras.js';
import { createMultiplayerLobby } from './multiplayer_lobby.js';
import { createMultiplayerRun, applyMultiplayerAction, MULTI_ITEM_NAMES } from './multiplayer_rules.js';
import { createAimLabels } from './aim_labels.js';
import { multiPickRegion, multiAimTargetAt, MULTI_SLOT_RECTS } from './multiplayer_hit_regions.js';

const MOVEMENT = InputPermissionCategory.Movement;
const CAMERA = InputPermissionCategory.Camera;
const RECOVERY = 'roulette_table:seat_recovery_v1';
const LEGACY_PROBE = 'roulette_table:probe_recovery_v1';
const NIGHT_VISION = 'minecraft:night_vision';
const STEAL_NIGHT_AMPLIFIER = 1;
// Short effects blink out in their final seconds, so we hand out a very long one
// and remove it ourselves when the sequence ends.
const NIGHT_VISION_TICKS = 20*60*60*24;
const NIGHT_VISION_MARK = NIGHT_VISION_TICKS/2;
const store = createGameStore(world, { validateSnapshot });
const runtime = createSessions({store,createRun,applyAction,
  makeRunId: () => `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`});
let sequence = 0;
const seats = new Map(), menus = new Map(), lastInput = new Map();
const tell = (p,text) => p.onScreenDisplay.setActionBar(text);
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const resumeFailures = {'table-busy':'这张桌子已有玩家。','no-run':'没有可继承的对局。',corrupt:'存档无法读取，原档没有被覆盖。'};
const DEALER_ITEM_DELAY = 20;
const DEALER_DRAW_DELAY = 30;
const NOTICE_TICKS = 60;
const multiLobby = createMultiplayerLobby({now:() => Date.now()});
const multiGames = new Map(), multiSeats = new Map();
const MULTI_RULES_TEXT = '§l道具使用§r\n轮到你时可以连续使用道具，使用道具不消耗行动；开枪后才交给下一位。\n\n§l射击目标§r\n可以选择任意仍存活的玩家，包括自己。\n\n§l实弹与空包弹§r\n实弹扣除目标电量，空包弹不扣电；装填数量和道具在桌面上公开。';
const MULTI_CONFIG_TEXT = '当前版本使用默认配置：四人桌、每人8格道具位、每次装填补发2件道具。配置选项暂未开放。';
const RULES_TEXT = '§l操作§r\\n道具盒出现后，按使用键领取道具。\\n准星对准道具格，按一次使用键（鼠标右键）立即使用。\\n准星对准枪区，按使用键进入待射击。再对准远半桌「庄家」或近半桌「你」，按使用键确认目标。\\n\\n§l目标§r\\n保住自己的电量，让庄家的电量归零。每组有三关，打完第三关就能选择兑现或继续挑战。\\n\\n§l翻倍与兑现§r\\n收手兑现会结束对局，成绩计入排行榜。继续挑战后，通关下一组可让当前分数翻倍。如果挑战失败，本局未兑现的分数全部失去。';

// Prompts are short-lived: they appear for a moment and then clear themselves.
function announce(p,seat,text,ticks = NOTICE_TICKS) {
  seat.notice = text;
  seat.noticeUntil = system.currentTick + ticks;
  tell(p,text);
}

function clearNightVision(p, saved) {
  if (saved.stealVision !== true) return;
  const effect = p.getEffect(NIGHT_VISION);
  // Only remove the long-lived one we granted; never a potion the player owns.
  if (effect?.amplifier === STEAL_NIGHT_AMPLIFIER && effect.duration > NIGHT_VISION_MARK) {
    p.removeEffect(NIGHT_VISION);
  }
}

function updateStealVision(p, seat, active) {
  if (!!seat.stealVision === active) return;
  const saved = JSON.parse(p.getDynamicProperty(RECOVERY));
  if (active) {
    const effect = p.getEffect(NIGHT_VISION);
    if (!effect) {
      saved.stealVision = true;
      p.setDynamicProperty(RECOVERY,JSON.stringify(saved));
      seat.stealVision = true;
      p.addEffect(NIGHT_VISION,NIGHT_VISION_TICKS,{amplifier:STEAL_NIGHT_AMPLIFIER,showParticles:false});
    } else {
      // Refresh our own long effect instead of letting it tick down and blink.
      if (effect.amplifier === STEAL_NIGHT_AMPLIFIER && effect.duration < NIGHT_VISION_MARK) {
        p.addEffect(NIGHT_VISION,NIGHT_VISION_TICKS,{amplifier:STEAL_NIGHT_AMPLIFIER,showParticles:false});
      }
      seat.stealVision = true;
    }
  } else {
    clearNightVision(p,saved);
    delete saved.stealVision;
    p.setDynamicProperty(RECOVERY,JSON.stringify(saved));
    seat.stealVision = false;
  }
}

function setViewLock(p, lock) {
  const saved = JSON.parse(p.getDynamicProperty(RECOVERY));
  if (lock && typeof saved.cameraInput !== 'boolean') {
    saved.cameraInput = p.inputPermissions.isPermissionCategoryEnabled(CAMERA);
    p.setDynamicProperty(RECOVERY, JSON.stringify(saved));
    p.inputPermissions.setPermissionCategory(CAMERA,false);
  } else if (!lock && typeof saved.cameraInput === 'boolean') {
    p.inputPermissions.setPermissionCategory(CAMERA,saved.cameraInput);
    delete saved.cameraInput;
    p.setDynamicProperty(RECOVERY,JSON.stringify(saved));
  }
}

function recover(p) {
  try {
    for (const key of [RECOVERY,LEGACY_PROBE]) {
      const raw = p.getDynamicProperty(key);
      if (raw === undefined) continue;
      const saved = JSON.parse(raw);
      if (typeof saved?.movement !== 'boolean') return false;
      p.inputPermissions.setPermissionCategory(MOVEMENT,saved.movement);
      if (typeof saved.cameraInput === 'boolean') p.inputPermissions.setPermissionCategory(CAMERA,saved.cameraInput);
      if (saved.camera === true) p.camera.clear();
      clearNightVision(p,saved);
      clearStealPosition(p,saved);
      p.setDynamicProperty(key,undefined);
    }
    stopGameMusic(p);
    return true;
  } catch (error) { console.warn(`Roulette recovery: ${error}`); return false; }
}

const display = createDisplayManager();
const aimLabels = createAimLabels(world);

function detach(id) {
  const seat = seats.get(id), snap = runtime.current(id);
  const ticks = seat ? system.currentTick-seat.lastClock : 0;
  if (snap && ticks > 0 && !playingScene(seat) && clockRunning(snap.state)) {
    const saved = runtime.dispatch(id,snap,{type:'tick',ticks});
    if (!saved.ok) console.warn(`Roulette clock checkpoint: ${saved.reason}`);
  }
  if (seat) display.remove(seat.table.key);
  aimLabels.remove(id);
  seats.delete(id);
  menus.delete(id);
  lastInput.delete(id);
  runtime.leave(id);
}

const GAME_MUSIC = 'music.game';
const MUSIC_ACTIVE = 'roulette_table:music_active_v1';
const TABLE_SOUNDS = {
  shot_live:'random.explode', shot_blank:'random.click',
  grab:'random.pop', briefcase_open:'random.chestopen', briefcase_hide:'random.chestclosed',
  health_down:'note.bass', health_up:'random.orb', shell_load:'random.anvil_land',
};

function playSound(p,id,volume=1) {
  try { p.playSound?.(id,{volume}); } catch (error) { console.warn(`Roulette sfx: ${error}`); }
}

function sfx(p,key,volume=1) { playSound(p,TABLE_SOUNDS[key],volume); }

const ITEM_SOUNDS = {
  beer:'random.drink', cigarette:'fire.ignite', cuffs:'random.anvil_land',
  saw:'dig.wood', magnifier:'random.glass', adrenaline:'random.fizz',
  inverter:'note.bit', phone:'random.orb', expired:'random.eat',
};

/** Cues for resolved actions only, never for a hidden shell or item. */
function cueEffects(p,seat,before,after,events) {
  const shot = events.find(event=>event.type === 'shot');
  for (const event of events) {
    if (event.type === 'shot') {
      if (event.shell === 'live' && event.to === 'player') {
        if (p.getDynamicProperty(MUSIC_ACTIVE) === true) {
          stopGameMusic(p);
          seat.resumeMusicOnDefib = true;
        }
        playSound(p,'random.anvil_land',.7);
      } else sfx(p,event.shell === 'live' ? 'shot_live' : 'shot_blank');
    } else if (event.type === 'itemUsed' && ITEM_SOUNDS[event.id]) {
      playSound(p,ITEM_SOUNDS[event.id],.65);
    } else if ((event.type === 'collected' && event.who === 'player') || event.type === 'steal') {
      sfx(p,'grab',.8);
    } else if (event.type === 'boxClosed') {
      sfx(p,'briefcase_hide');
    } else if (event.type === 'dead' && event.who === 'dealer' && shot?.to === 'dealer') {
      const {table} = seat;
      try {
        table.dimension.spawnParticle('minecraft:totem_particle',tableToWorld(table,1.5,2.05,.25));
      } catch (error) { console.warn(`Roulette dealer particles: ${error}`); }
    }
  }
  if (!shot && events.some(event=>event.type === 'hp')) {
    const hpBefore = before.player.hp+before.dealer.hp;
    const hpAfter = after.player.hp+after.dealer.hp;
    if (hpAfter < hpBefore) sfx(p,'health_down');
    else if (hpAfter > hpBefore) sfx(p,'health_up');
  }
}

function startGameMusic(p) {
  if (typeof p.playMusic !== 'function' || typeof p.stopMusic !== 'function') return;
  try {
    p.setDynamicProperty(MUSIC_ACTIVE,true);
    try {
      p.playMusic(GAME_MUSIC,{volume:.35,fade:.35,loop:true});
    } catch (error) {
      p.setDynamicProperty(MUSIC_ACTIVE,undefined);
      throw error;
    }
  } catch (error) { console.warn(`Roulette music: ${error}`); }
}

function stopGameMusic(p) {
  try {
    // Player.stopMusic has no per-track selector. Do not touch music for idle players.
    if (p.getDynamicProperty(MUSIC_ACTIVE) !== true) return;
    p.stopMusic();
    p.setDynamicProperty(MUSIC_ACTIVE,undefined);
  } catch (error) { console.warn(`Roulette music cleanup: ${error}`); }
}

function leave(p, message) {
  stopGameMusic(p);
  detach(p.id);
  tell(p,recover(p) ? message : '权限恢复暂未完成，稍后重试。');
}

function finish(p, stamp) {
  const result = runtime.finalize(p.id,stamp,p.name);
  if (result.ok) {
    const score = result.result?.score;
    leave(p,score === null ? '本局结束，移动已恢复。' : `兑现 ${score}，移动已恢复。`);
    p.sendMessage(score === null ? '轮盘：本局未兑现。' : `轮盘：本局兑现 ${score}。`);
  } else leave(p,'结算未写入。移动已恢复，重新继承可重试结算。');
}

function join(p, table, mode, confirmed = false, expected = null) {
  if (runtime.current(p.id) || runtime.owner(table.key)) return tell(p,'这张桌子或玩家已在对局中。');
  if (p.dimension.id !== table.dimension.id || !tableIntact(table) || !recover(p)) return;
  const spot = seatAt(table), at = p.location;
  if (distance(at,spot) > 6) return tell(p,'请先靠近牌桌近端。');
  const issue = seatIssue(table.dimension,spot);
  if (issue) return tell(p,issue);
  const saved = store.load(p.id);
  if (!saved.ok) return tell(p,resumeFailures[saved.reason] ?? '暂时无法读取进度。');
  if (expected && (saved.runId !== expected.runId || saved.revision !== expected.revision)) return tell(p,'存档已变化，请重新打开表单。');
  if (mode === 'resume' && !saved.runId) return tell(p,resumeFailures['no-run']);
  if (mode === 'new' && saved.runId && !confirmed) return;
  p.setDynamicProperty(RECOVERY,JSON.stringify({ movement:p.inputPermissions.isPermissionCategoryEnabled(MOVEMENT) }));
  try {
    const yaw = ((180 + table.turn*90 + 180) % 360) - 180;
    if (!p.tryTeleport(spot,{rotation:{x:38,y:yaw},checkForBlocks:true})) throw Error('seat blocked');
    p.inputPermissions.setPermissionCategory(MOVEMENT,false);
    const connected = runtime.join(p.id,table.key,{mode,confirmed,seed:Math.floor(Math.random()*0xffffffff)+1});
    if (!connected.ok) return leave(p,resumeFailures[connected.reason] ?? '入座未成功，原进度保留。');
    const seat = {table,spot,next:system.currentTick+50,lastClock:system.currentTick};
    seats.set(p.id,seat);
    startGameMusic(p);
    if (connected.session.state.phase === 'steal') enterStealPosition(p,seat);
    if (connected.session.state.phase === 'ended') finish(p,connected.session);
  } catch (error) {
    leave(p,'入座失败，已尝试恢复移动。');
    console.warn(`Roulette join: ${error}`);
  }
}

function queueScenes(seat, steps) {
  if (steps.length) (seat.scenes ??= []).push(...steps);
}

function playingScene(seat) { return !!(seat?.step || seat?.scenes?.length); }

function markSceneCamera(p,seat) {
  const saved = JSON.parse(p.getDynamicProperty(RECOVERY));
  if (!saved.camera) p.setDynamicProperty(RECOVERY,JSON.stringify({...saved,camera:true}));
  seat.cameraActive = true;
}

const INVISIBILITY = 'minecraft:invisibility';
const STEAL_INVIS_AMPLIFIER = 1;

function clearStealPosition(p,saved,force=false) {
  const travel = saved.stealTravel;
  if (!travel) return;
  if (p.dimension.id === travel.dimension && (force || distance(p.location,travel.forward) <= .75)) {
    if (!p.tryTeleport(travel.home,{checkForBlocks:false})) throw Error('steal return rejected');
  }
  if (travel.invisibility && p.getEffect(INVISIBILITY)?.amplifier === STEAL_INVIS_AMPLIFIER) {
    p.removeEffect(INVISIBILITY);
  }
}

function enterStealPosition(p,seat) {
  if (seat.stealSpot || seat.stealPending) return;
  const [dx,dz] = rotate(seat.table.turn,0,-STEAL_ADVANCE);
  const forward = {...seat.spot,x:seat.spot.x+dx,z:seat.spot.z+dz};
  const saved = JSON.parse(p.getDynamicProperty(RECOVERY));
  saved.stealTravel = {dimension:p.dimension.id,home:seat.spot,forward,invisibility:!p.getEffect(INVISIBILITY)};
  p.setDynamicProperty(RECOVERY,JSON.stringify(saved));
  if (saved.stealTravel.invisibility) {
    const result = p.runCommand(`effect @s invisibility infinite ${STEAL_INVIS_AMPLIFIER} true`);
    if (result?.successCount === 0) throw Error('steal invisibility rejected');
  }
  const yaw = ((180 + seat.table.turn*90 + 180) % 360) - 180;
  const rotation = {x:43,y:yaw};
  const eye = p.getHeadLocation();
  const current = p.getRotation();
  const destination = {...eye,x:eye.x+dx,z:eye.z+dz};
  queueScenes(seat,[
    {travel:'capture',ticks:1,lockView:true,highlight:true,location:eye,rotation:current},
    {travel:'align',ticks:10,lockView:true,highlight:true,location:eye,rotation},
    {travel:'slide',ticks:20,lockView:true,highlight:true,location:destination,rotation},
    {travel:'arrive',ticks:1,lockView:true,highlight:true,forward,rotation},
  ]);
  seat.stealPending = true;
  updateStealVision(p,seat,true);
  advanceScenes(p,seat,system.currentTick);
}

function settleStealPosition(p,seat) {
  if (!seat.stealSpot) return;
  const saved = JSON.parse(p.getDynamicProperty(RECOVERY));
  clearStealPosition(p,saved,true);
  delete saved.stealTravel;
  p.setDynamicProperty(RECOVERY,JSON.stringify(saved));
  seat.stealSpot = null;
}

function advanceScenes(p, seat, now) {
  if (seat.defibSoundAt !== undefined && now >= seat.defibSoundAt) {
    seat.defibSoundAt = undefined;
    playSound(p,'random.fizz',.8);
    if (seat.resumeMusicOnDefib) {
      seat.resumeMusicOnDefib = false;
      startGameMusic(p);
    }
  }
  if (seat.step && now < seat.stepUntil) return true;
  const next = seat.scenes?.shift();
  seat.step = next;
  try {
    if (!next && seat.cameraActive) {
      p.camera.clear();
      seat.cameraActive = false;
      const saved = JSON.parse(p.getDynamicProperty(RECOVERY));
      delete saved.camera;
      p.setDynamicProperty(RECOVERY,JSON.stringify(saved));
    }
    if (seat.viewLocked || next?.lockView) {
      setViewLock(p,!!next?.lockView);
      seat.viewLocked = !!next?.lockView;
    }
    if (!next) return false;
    seat.stepUntil = now + next.ticks;
    if (next.healthCue) sfx(p,'health_down');
    if (next.shells) {
      sfx(p,'shell_load');
    }
    if (next.travel === 'arrive') {
      if (!p.tryTeleport(next.forward,{checkForBlocks:false,rotation:next.rotation})) throw Error('steal teleport rejected');
      seat.stealSpot = next.forward;
      seat.stealPending = false;
    } else if (next.travel) {
      markSceneCamera(p,seat);
      const options = {location:next.location,rotation:next.rotation};
      if (next.travel !== 'capture') options.easeOptions = {easeTime:(next.ticks-2)/20,easeType:'InOutSine'};
      setFreeCamera(p,options);
    } else {
      playStep(p,seat.table,next,() => markSceneCamera(p,seat));
      if (next.defibCue) seat.defibSoundAt = now + DEFIB_CUE_TICKS;
    }
  } catch (error) {
    if (seat.viewLocked || next?.lockView) throw error;
    console.warn(`Roulette camera: ${error}`);
    seat.scenes = [];
    seat.step = undefined;
    if (seat.cameraActive) { p.camera.clear(); seat.cameraActive = false; }
    return false;
  }
  return true;
}

function clockRunning(state) {
  return state.phase === 'steal' || (state.group === 1 && !['double','ended'].includes(state.phase) && state.elapsedTicks < 20997);
}

function act(p, action) {
  const snap = runtime.current(p.id);
  const seat = seats.get(p.id);
  if (!snap || !seat) return;
  const now = system.currentTick;
  const elapsed = action.type !== 'tick' && clockRunning(snap.state) ? Math.max(0,now-seat.lastClock) : 0;
  const output = runtime.dispatch(p.id,snap,action,elapsed);
  if (!output.ok) {
    if (output.reason !== 'invalid-action') leave(p,'保存失败，对局已暂停，原进度保留。');
    return;
  }
  const nextPhase = output.session.state.phase;
  const oldPhase = snap.state.phase;
  if (oldPhase !== nextPhase && nextPhase === 'double') seat.doubleMenuShown = false;
  seat.lastClock = now;
  if (action.type !== 'tick' || oldPhase !== nextPhase) {
    seat.next = now + (nextPhase === 'loadReveal' ? 40 : 0);
    seat.dealerDrawUntil = undefined;
    if (nextPhase === 'dealerTurn') {
      seat.dealerWait = (action.type === 'dealer' && action.move === 'useItem') ? DEALER_ITEM_DELAY : 0;
    }
  }
  const planned = cameraPlan(output.events,snap.state);
  const dealt = output.session.state;
  if (nextPhase === 'playerTurn' && (oldPhase === 'collect' || oldPhase === 'loadReveal')) {
    if (oldPhase === 'collect') planned.push({name:'home',ticks:20});
    planned.push(ammoReveal(dealt));
  }
  const used = output.events.find(e=>e.type === 'itemUsed' && e.by === 'dealer');
  const phone = eventText(output.events.find(e=>e.type === 'peekAt' && e.by === 'player'));
  const blankShot = output.events.find(e=>e.type === 'shot' && e.by === 'dealer' && e.shell === 'blank');
  const notice = phone ?? (used && ITEM_NAMES[used.id] ? `恶魔使用了${ITEM_NAMES[used.id]}`
    : blankShot ? (blankShot.to === 'player' ? '恶魔 射击了 你' : '恶魔 射击了 自己') : null);
  if (notice) {
    if (planned.length) seat.noticeAfterScene = notice;
    else announce(p,seat,notice);
  }
  if (nextPhase === 'collect' && oldPhase !== nextPhase) sfx(p,'briefcase_open');
  cueEffects(p,seat,snap.state,output.session.state,output.events);
  try {
    if (output.session.state.phase === 'steal') enterStealPosition(p,seat);
    else settleStealPosition(p,seat);
  } catch (error) {
    console.warn(`Roulette steal position: ${error}`);
    return leave(p,'抢取位置切换失败，进度已保存。');
  }
  if (seat.stealVision && output.session.state.phase !== 'steal' && !planned[0]?.highlight) updateStealVision(p,seat,false);
  queueScenes(seat,planned);
  if (planned[0]?.hideDealer) {
    try { display.setDealerHidden(seat.table.key,true); }
    catch (error) { console.warn(`Roulette dealer visibility: ${error}`); }
  }
  if (planned[0]?.lockView) {
    try {
      advanceScenes(p,seat,now,output.session.state.phase);
      if (planned[0].highlight) updateStealVision(p,seat,true);
    } catch (error) {
      console.warn(`Roulette hit scene: ${error}`);
      return leave(p,'受击演出异常，进度已保存。');
    }
  }
  if (output.session.state.phase === 'ended' && !playingScene(seat)) finish(p,output.session);
}

function menuValid(p, token) { return menus.get(p.id) === token; }
function entryValid(p, table) {
  const near = table.multi ? ['south','north','east','west'].some(seat=>distance(p.location,multiSeatAt(table,seat))<=6)
    : distance(p.location,seatAt(table))<=6;
  return p.dimension.id === table.dimension.id && near && tableIntact(table);
}

async function board(p, token) {
  let page = 0;
  while (menuValid(p,token)) {
    const rows = store.leaderboard(page,10);
    if (!rows.ok) { tell(p,'排行榜暂时无法读取。'); return; }
    const pages = Math.max(1,Math.ceil(rows.total/10));
    const text = rows.entries.map(r => `${r.rank}. ${r.displayName || '玩家'}  ${r.score}`).join('\n');
    const form = new ActionFormData().title('轮盘排行榜').body(`${page+1} / ${pages}\n\n${text || '暂无兑现记录'}`);
    const actions = [];
    if (page > 0) { form.button('上一页'); actions.push(-1); }
    if (page+1 < pages) { form.button('下一页'); actions.push(1); }
    form.button('关闭');
    const r = await showLockedForm(p,table,token,lock.token,form,'lobby');
    if (r.canceled || actions[r.selection] === undefined) return;
    page += actions[r.selection];
  }
}

function leaveMultiSeat(p, tableKey) {
  const pos = multiSeats.get(p.id);
  const result = multiLobby.leave(tableKey,p.id);
  if (result.ok) {
    const saved = JSON.parse(p.getDynamicProperty(RECOVERY) ?? '{}');
    if (typeof saved.movement === 'boolean') p.inputPermissions.setPermissionCategory(MOVEMENT,saved.movement);
    p.setDynamicProperty(RECOVERY,undefined);
    multiSeats.delete(p.id);
  }
  return result;
}

function multiNames(tableKey) {
  const order = {north:0,east:1,south:2,west:3};
  return multiLobby.players(tableKey).sort((a,b)=>order[a.seat]-order[b.seat]).map(entry=>entry.playerId);
}

function multiStart(tableKey) {
  const ids = multiNames(tableKey);
  const game = {state:createMultiplayerRun(ids,Math.floor(Math.random()*0xffffffff)+1),nextBotTick:system.currentTick+20};
  const output = applyMultiplayerAction(game.state,{type:'advance'});
  game.state = output.state;
  multiGames.set(tableKey,game);
  multiBroadcast(tableKey,output.events);
  return output.events;
}

function multiLocalHit(table,eye,direction) {
  if (!eye||!direction||direction.y>=-.001) return null;
  const height=table.origin.y+9/16;
  const t=(height-(eye.y+.1))/direction.y;
  if(t<0||t>8)return null;
  const local=worldToTable(table,{x:eye.x+direction.x*t,y:height,z:eye.z+direction.z*t});
  const {x,z}=local, c=1;
  if(x<0||x>5||z<0||z>5||x+z<c||5-x+z<c||x+5-z<c||10-x-z<c)return null;
  return local;
}

function multiStep(tableKey, action, expectedState) {
  const game = multiGames.get(tableKey);
  if (!game || (expectedState && game.state !== expectedState)) return null;
  let output = applyMultiplayerAction(game.state,action);
  if (!output) return null;
  const events = [...output.events];
  game.state = output.state;
  if (game.state.phase === 'load') {
    const loaded = applyMultiplayerAction(game.state,{type:'advance'});
    if (loaded) { game.state=loaded.state; events.push(...loaded.events); }
  }
  return events;
}

async function multiChoice(p,table,title,options) {
  if (menus.has(p.id)) return null;
  const token={}; menus.set(p.id,token);
  try {
    const form=new ActionFormData().title(title);
    for(const option of options) form.button(option.label);
    const response=await form.show(p);
    return response.canceled||menus.get(p.id)!==token?null:options[response.selection]??null;
  } catch(error) { console.warn(`Multiplayer choice: ${error}`); return null; }
  finally { if(menus.get(p.id)===token) menus.delete(p.id); }
}

function multiPlayerName(tableKey,id){
  const online=world.getAllPlayers().find(p=>p.id===id);
  if(online)return online.name;
  const entry=multiLobby.players(tableKey).find(p=>p.playerId===id);
  const label={north:'北座',east:'东座',south:'南座',west:'西座'};
  return entry?label[entry.seat]??'玩家':'离场玩家';
}
function multiBroadcast(tableKey,events) {
  const game=multiGames.get(tableKey);
  const label=id=>multiPlayerName(tableKey,id);
  const text=events.map(e=>{
    if(e.type==='shot') return `${label(e.by)} 射击 ${label(e.to)}：${e.shell==='live'?'实弹':'空包弹'}`;
    if(e.type==='itemUsed') return `${label(e.by)} 使用了${MULTI_ITEM_NAMES[e.id]??e.id}`;
    if(e.type==='dead') return `${label(e.who)} 已出局`;
    if(e.type==='skip') return `${label(e.who)} 被游戏机限制，跳过行动`;
    if(e.type==='itemGranted') return `${label(e.to)} 获得${MULTI_ITEM_NAMES[e.id]??'道具'}`;
    if(e.type==='load') return `第 ${game?.state.round??1} 局装弹：实弹 ${e.live} · 空包弹 ${e.blank} · 先手 ${label(e.first)}`;
    if(e.type==='roundEnd') return e.winner ? `第 ${e.round} 局：${label(e.winner)} 获胜` : `第 ${e.round} 局平局`;
    if(e.type==='nextRound') return `第 ${e.round} 局开始，先手：${label(e.first)}`;
    if(e.type==='matchEnd') return e.winner ? `比赛结束：${label(e.winner)} 获胜` : '比赛结束：平局';
    return '';
  }).filter(Boolean).join(' | ');
  const current=game?.state.players[game.state.current];
  const status=current?`当前行动：${label(current.id)}`:'';
  for(const entry of multiLobby.players(tableKey)){
    const player=world.getAllPlayers().find(p=>p.id===entry.playerId);
    if(player)tell(player,[text,status].filter(Boolean).join(' | '));
  }
}

async function multiActFromHit(p,table,local) {
  const game=multiGames.get(table.key), my=multiLobby.getPlayer(p.id);
  if(!game||!my||!local) return;
  if(game.state.phase==='ended') { leaveMultiSeat(p,table.key); return tell(p,'比赛已结束，已退出座位。'); }
  const expected=game.state;
  const actor=expected.players[expected.current];
  if(actor?.id!==p.id) { tell(p,`等待 ${actor?.id??'其他玩家'} 行动。`); return; }
  if(game.state.phase==='aim') {
    const zone=multiPickRegion(local.x,local.z);
    if(zone?.kind!=='aim') { tell(p,'准星对准桌面四侧的目标区。'); return; }
    const seat=multiAimTargetAt(local.x,local.z);
    const entry=multiLobby.players(table.key).find(q=>q.seat===seat);
    const target=game.state.players.find(q=>q.id===entry?.playerId&&q.alive);
    if(!target){tell(p,'这个座位没有存活玩家。');return;}
    const events=multiStep(table.key,{type:'shoot',target:target.id},game.state);
    if(events)multiBroadcast(table.key,events);else tell(p,'射击动作已过期，请重新对准。');
    return;
  }
  const hit=multiPickRegion(local.x,local.z);
  if(hit?.kind==='gun') { const events=multiStep(table.key,{type:'aim'},expected);if(events)tell(p,'待射击：对准目标区选择玩家。');return; }
  if(hit?.kind==='slot'&&hit.seat===my.seat) {
    const item=actor.items[hit.slot];
    if(!item) { tell(p,'这个道具格是空的。'); return; }
    let target,stealSlot;
    if(item==='gameMachine'||item==='adrenaline') {
      const choices=game.state.players.filter(q=>q.alive&&q.id!==p.id);
      const selected=await multiChoice(p,table,item==='gameMachine'?'选择被限制的玩家':'选择要抢取道具的玩家',choices.map(q=>({label:q.id,id:q.id})));
      if(!selected) return;
      target=selected.id;
      if(item==='adrenaline') {
        const victim=game.state.players.find(q=>q.id===target);
        const slots=victim.items.map((id,slot)=>id?{id,slot}:null).filter(Boolean);
        const stolen=await multiChoice(p,table,'选择要抢的道具',slots.map(q=>({label:`${q.slot+1}. ${MULTI_ITEM_NAMES[q.id]??q.id}`,slot:q.slot})));
        if(!stolen) return;
        stealSlot=stolen.slot;
      }
    }
    const events=multiStep(table.key,{type:'useItem',slot:hit.slot,target,stealSlot},expected);
    if(events) multiBroadcast(table.key,events); else tell(p,'行动状态已变化，请重新瞄准。');
    return;
  }
  tell(p,'请先对准中央枪区进入待射击，再对准四侧目标区开枪。');
}

function showLockedForm(p,table,token,lockToken,form,route='lobby') {
  return new Promise(resolve=>{
    let settled=false;
    const timeout=system.runTimeout(()=>{
      if(settled)return;
      settled=true;
      multiLobby.release(table.key,p.id,lockToken);
      if(menus.get(p.id)===token) menus.delete(p.id);
      tell(p,'表单已超时关闭，请重新点击桌面。');
      resolve(null);
    },600);
    form.show(p).then(response=>{
      if(settled)return;
      settled=true; system.clearRun(timeout);
      if(!menuValid(p,token)||!multiLobby.lockValid(table.key,p.id,lockToken)) return resolve(null);
      multiLobby.touch(table.key,p.id,route);
      resolve(response);
    }).catch(error=>{
      if(settled)return;
      settled=true; system.clearRun(timeout); console.warn(`Multiplayer form: ${error}`); resolve(null);
    });
  });
}

async function multiChoose(p,table,title,options) {
  const lock=multiLobby.acquire(table.key,p.id,'target');
  if(!lock.ok){tell(p,'桌面正在由另一位玩家操作。');return null;}
  const token={}; menus.set(p.id,token);
  try {
    const form=new ActionFormData().title(title);
    for(const option of options) form.button(option.label);
    const response=await showLockedForm(p,table,token,lock.token,form,'target');
    return response ? options[response.selection] ?? null : null;
  } finally {
    multiLobby.release(table.key,p.id,lock.token);
    if(menus.get(p.id)===token)menus.delete(p.id);
  }
}

function multiBotAction(tableKey,game) {
  const state=game.state;
  const bot=state.players[state.current];
  if(!bot?.id.startsWith('bot:'))return;
  const seatOrder=['north','east','south','west'];
  const seat=multiLobby.players(tableKey).find(entry=>entry.playerId===bot.id)?.seat;
  const botIndex=seatOrder.indexOf(seat);
  const humanStart=Number.isInteger(bot.seat)?bot.seat:Math.max(0,botIndex);
  const human=Array.from({length:state.players.length},(_,i)=>state.players[(humanStart+i+1)%state.players.length])
    .find(p=>p.alive&&!p.id.startsWith('bot:'));
  if(!human)return;
  const mapId=id=>id==='gameMachine'?'cuffs':id;
  const dealerState={phase:'dealerTurn',dealer:{hp:bot.hp,items:bot.items.map(mapId),known:bot.known},
    player:{hp:human.hp,items:human.items.map(mapId),known:human.known},shells:state.shells,
    liveLeft:state.live,maxHp:bot.maxHp,sawActive:bot.sawActive,cuffed:{player:human.skip,dealer:bot.skip}};
  const decision=dealerAction(dealerState);
  if(!decision)return;
  let events;
  if(decision.move==='useItem'){
    const id=bot.items[decision.slot];
    events=multiStep(tableKey,{type:'useItem',slot:decision.slot,target:human.id,
      stealSlot:decision.stealSlot},state);
  } else {
    events=multiStep(tableKey,{type:'aim'},state);
    if(events){const shot=multiStep(tableKey,{type:'shoot',target:decision.target==='self'?bot.id:human.id});if(shot)events.push(...shot);}
  }
  if(events)multiBroadcast(tableKey,events);
  game.nextBotTick=system.currentTick+20;
}

async function multiGameMenu(p, table) {
  if(!multiLobby.getPlayer(p.id)) return;
  const seated=multiLobby.getPlayer(p.id);
  if(!seated||seated.tableKey!==table.key)return;
  const game=multiGames.get(table.key);
  if(!game)return multiMenu(p,table);
  const actor=game.state.players[game.state.current];
  const text=game.state.phase==='ended'
    ? (game.state.winner?`${game.state.winner} 获胜`:'多人对局结束')
    : actor?.id===p.id
      ? (game.state.phase==='aim'?'待射击：对准任一座位选择目标。':'你的回合：准星对准道具格使用道具，准星对准中央枪区开始射击。')
      : `等待 ${multiPlayerName(table.key,actor?.id)} 行动。`;
  tell(p,`第 ${game.state.round} 局  ${text}  实弹 ${game.state.live} · 空包弹 ${game.state.blank}  积分 ${game.state.players.map(q=>`${multiPlayerName(table.key,q.id)}:${game.state.scores[q.id]??0}`).join(' ')}`);
}

async function multiMenu(p, table) {
  if (!table.multi || menus.has(p.id) || !entryValid(p,table)) return;
  const existing=multiLobby.getPlayer(p.id);
  if(existing && existing.tableKey!==table.key){tell(p,'你已经在另一张多人桌入座。');return;}
  if (multiGames.has(table.key)) return multiGameMenu(p,table);
  multiLobby.ensure(table.key);
  const token = {};
  menus.set(p.id,token);
  const lock = multiLobby.acquire(table.key,p.id,'lobby');
  if (!lock.ok) { tell(p,'当前有其他玩家正在操作这张桌子的表单。'); menus.delete(p.id); return; }
  const unlock = () => { multiLobby.release(table.key,p.id,lock.token); if (menus.get(p.id)===token) menus.delete(p.id); };
  let reopenLobby=false;
  try {
    let lobby = multiLobby.get(table.key);
    const current = multiLobby.getPlayer(p.id);
    if (!current) {
      const emptySeats=['south','north','east','west'].filter(seat=>!lobby.seats[seat]);
      const occupied=Object.values(lobby.seats).some(Boolean);
      const form = new ActionFormData().title('四人轮盘牌桌').body(occupied ? '选择空座位，或查看规则。' : '请选择座位或查看规则。');
      const options=[];
      for(const seat of emptySeats){form.button(`坐${({south:'南',north:'北',east:'东',west:'西'})[seat]}`);options.push({type:'seat',seat});}
      if(!occupied){form.button('游戏配置');options.push({type:'config'});}
      form.button('关于规则');options.push({type:'rules'});
      const r = await showLockedForm(p,table,token,lock.token,form,'lobby');
      if (!r || r.canceled || !menuValid(p,token)) return;
      const option=options[r.selection];
      if(option?.type==='config'){
        multiLobby.touch(table.key,p.id,'config');
        const sub=await showLockedForm(p,table,token,lock.token,new ActionFormData().title('游戏配置').body(MULTI_CONFIG_TEXT).button('返回'),'config');
        if(sub&&!sub.canceled&&menuValid(p,token)&&entryValid(p,table))reopenLobby=true;
        return;
      }
      if(option?.type==='rules'){
        multiLobby.touch(table.key,p.id,'rules');
        const sub=await showLockedForm(p,table,token,lock.token,new ActionFormData().title('关于规则').body(MULTI_RULES_TEXT).button('关闭'),'rules');
        if(sub&&!sub.canceled&&menuValid(p,token)&&entryValid(p,table))reopenLobby=true;
        return;
      }
      const seat=option?.seat;
      if(!seat)return;
      const joined = multiLobby.enter(table.key,p.id,seat);
      if (!joined.ok) return tell(p,joined.reason === 'seat-busy' ? '这个座位已经有人。' : '入座失败。');
      const spot = multiSeatAt(table,seat);
      if (seatIssue(table.dimension,spot)) { multiLobby.leave(table.key,p.id); return tell(p,'座位脚下需要完整方块并且上方留空。'); }
      const movement=p.inputPermissions.isPermissionCategoryEnabled(MOVEMENT);
      p.setDynamicProperty(RECOVERY,JSON.stringify({movement}));
      multiSeats.set(p.id,{table,seat,spot});
      try {
        if(!p.tryTeleport(spot,{checkForBlocks:true})) throw Error('seat blocked');
        p.inputPermissions.setPermissionCategory(MOVEMENT,false);
      } catch(error) {
        multiLobby.leave(table.key,p.id); multiSeats.delete(p.id);
        p.setDynamicProperty(RECOVERY,undefined);
        tell(p,'入座失败，已恢复移动。'); console.warn(`Multiplayer seat: ${error}`); return;
      }
      p.sendMessage(joined.host ? '你是房主。等待其他玩家入座后，可以开始游戏。' : '已入座，等待房主开始游戏。');
      return;
    }
    lobby = multiLobby.get(table.key);
    const host = lobby?.hostId === p.id;
    const playersCount=Object.values(lobby.seats).filter(Boolean).length;
    const form=new ActionFormData().title('四人轮盘牌桌').body(host?'你是房主。':'你已入座，等待房主。');
    const actions=[];
    if(host&&playersCount>=2){form.button('开始游戏');actions.push('start');}
    if(host&&playersCount<4){form.button('添加人机');actions.push('bot');}
    form.button('退出座位');actions.push('leave');
    const r = await showLockedForm(p,table,token,lock.token,form,'lobby');
    if (!r || r.canceled || !menuValid(p,token)) return;
    const action=actions[r.selection];
    if(action==='start'){
      const started=multiLobby.start(table.key,p.id);
      if(started.ok){multiStart(table.key);tell(p,'多人游戏已开始。');}
      else tell(p,'暂时无法开始多人游戏。');
    } else if(action==='bot'){
      const added=multiLobby.addBot(table.key,p.id);
      if(added.ok){tell(p,`已添加${({south:'南',north:'北',east:'东',west:'西'})[added.seat]}侧人机。`);reopenLobby=true;}
      else tell(p,'当前无法添加人机。');
    } else {
      leaveMultiSeat(p,table.key);
      tell(p,'已退出座位。');
    }
  } catch (error) { console.warn(`Multiplayer form: ${error}`); }
  finally { unlock(); if (reopenLobby && multiLobby.getPlayer(p.id)) system.run(()=>multiMenu(p,table)); }
}

async function menu(p, table) {
  if (menus.has(p.id) || !entryValid(p,table)) return;
  const token = {};
  menus.set(p.id,token);
  try {
    const snap = runtime.current(p.id);
    if (!snap) {
      const saved = store.load(p.id);
      if (!saved.ok) return tell(p,resumeFailures[saved.reason] ?? '暂时无法读取进度。');
      const entries = [{label:saved.runId ? '开始新对局' : '开始对局',route:'new'}];
      if (saved.runId) entries.push({label:'继续对局',route:'resume'});
      entries.push({label:'排行榜',route:'board'},{label:'规则',route:'rules'});
      const form = new ActionFormData().title('恶魔轮盘 · 单人无尽');
      for (const entry of entries) form.button(entry.label);
      const response = await form.show(p);
      if (response.canceled || !menuValid(p,token) || runtime.current(p.id) || !entryValid(p,table)) return;
      const route = entries[response.selection]?.route;
      if (route === 'board') return await board(p,token);
      if (route === 'rules') {
        await new ActionFormData().title('规则').body(RULES_TEXT).button('关闭').show(p);
        return;
      }
      if (route === 'resume') return join(p,table,'resume',false,saved);
      if (route !== 'new') return;
      if (saved.runId) {
        const confirm = await new MessageFormData().title('开始新的一局').body('新局建立后将替换未结算进度。')
          .button1('确认').button2('取消').show(p);
        if (confirm.canceled || confirm.selection !== 0 || !menuValid(p,token) || !entryValid(p,table)) return;
      }
      join(p,table,'new',!!saved.runId,saved);
      return;
    }
    if (snap.tableKey !== table.key) return;
    const fresh = () => {
      const latest = runtime.current(p.id);
      return menuValid(p,token) && entryValid(p,table) && latest?.sessionId === snap.sessionId &&
        latest.state.revision === snap.state.revision && latest.state.phase === snap.state.phase;
    };
    let entries = phaseMenu(snap.state);
    while (entries.length && fresh()) {
      const form = new ActionFormData().title('恶魔轮盘').body(statusText(snap.state));
      for (const entry of entries) form.button(entry.label);
      const response = await form.show(p);
      if (!fresh()) return;
      if (response.canceled) return response.cancelationReason;
      const entry = entries[response.selection];
      if (!entry) return;
      if (entry.route === 'items') { entries = itemMenu(snap.state); continue; }
      if (entry.route === 'leave') leave(p,'已中断。可在任意空闲桌继承。');
      else if (entry.action) act(p,entry.action);
      return;
    }
  } catch (error) {
    console.warn(`Roulette form: ${error}`);
  } finally { if (menuValid(p,token)) menus.delete(p.id); }
}

function aimAction(state,local) {
  if (!local) return null;
  if (state.phase === 'steal') {
    const slot = stealSlot(state,local);
    return slot === null ? null : {type:'steal',slot};
  }
  if (state.phase === 'aim') {
    const target = aimRegion(local.x,local.z);
    return target ? {type:'shoot',target} : null;
  }
  const region = pickRegion(local.x,local.z);
  if (['playerTurn','itemSelected'].includes(state.phase) && region?.kind === 'gun') return {type:'aim'};
  if ((state.phase === 'playerTurn' || state.phase === 'itemSelected') && region?.side === 'player' && state.player.items[region.slot]) {
    return {type:'useItem',slot:region.slot};
  }
  return null;
}

world.beforeEvents.playerInteractWithBlock.subscribe(event => {
  const p = event.player;
  const table = tableAt(event.block);
  if (!table) return;
  event.cancel = true;
  if (event.isFirstEvent === false) return;
  const captured = runtime.current(p.id);
  const locked = playingScene(seats.get(p.id));
  let local = null;
  if ((captured?.tableKey === table.key || (table.multi && multiLobby.getPlayer(p.id)?.tableKey===table.key)) && !locked) {
    try {
      const direction = p.getViewDirection?.();
      const ray = p.getBlockFromViewDirection({maxDistance:8});
      const f = event.faceLocation;
      const relative = f && [f.x,f.y,f.z].every(v=>Number.isFinite(v) && v >= -1e-6 && v <= 1+1e-6);
      const hit = ray?.block ? ray : relative ? {block:event.block,face:event.blockFace,faceLocation:f} : null;
      local = table.multi
        ? multiLocalHit(table,p.getHeadLocation?.(),direction)
        : feltHit(table,hit,p.getHeadLocation?.(),direction);
    } catch (error) { console.warn(`Roulette click sample: ${error}`); }
  }
  system.run(() => {
    try {
      if ((lastInput.get(p.id) ?? -100)+5 > system.currentTick || menus.has(p.id)) return;
      const snap = runtime.current(p.id);
      if (table.multi && multiLobby.getPlayer(p.id)?.tableKey===table.key && multiGames.has(table.key)) {
        if (locked) return;
        lastInput.set(p.id,system.currentTick);
        if (local) return multiActFromHit(p,table,local);
        return tell(p,'请将准星对准桌面区域。');
      }
      if (locked || captured?.sessionId !== snap?.sessionId || captured?.state.revision !== snap?.state.revision) return;
      lastInput.set(p.id,system.currentTick);
      if (snap?.tableKey === table.key) {
        if (!entryValid(p,table)) return leave(p,'牌桌失效，进度已保留。');
        if (playingScene(seats.get(p.id))) return;
        if (snap.state.phase === 'collect' && (local || event.blockFace === 'Up' || !event.blockFace)) return act(p,{type:'collect'});
        const action = aimAction(snap.state,local);
        if (action) return act(p,action);
        if (snap.state.phase === 'steal' && local && pickRegion(local.x,local.z)?.side === 'dealer') return;
      }
      void (table.multi && multiGames.has(table.key) ? multiGameMenu(p,table) : table.multi ? multiMenu(p,table) : menu(p,table));
    } catch (error) { console.warn(`Roulette interact: ${error}`); }
  });
});
world.afterEvents.playerSpawn.subscribe(({player}) => system.run(() => { if (!seats.has(player.id)) recover(player); }));
world.afterEvents.playerLeave.subscribe(({playerId}) => {
  const pos = multiLobby.getPlayer(playerId);
  if (pos) {
    multiLobby.leave(pos.tableKey,playerId);
    const events=multiStep(pos.tableKey,{type:'playerLeft',playerId});
    if(events) multiBroadcast(pos.tableKey,events);
  }
  multiSeats.delete(playerId);
  detach(playerId);
});
world.afterEvents.entityDie.subscribe(({deadEntity}) => { if (seats.has(deadEntity.id)) detach(deadEntity.id); });

system.runInterval(() => {
  multiLobby.tick();
  for (const [key,game] of multiGames) {
    if(game.state.phase==='ended'||system.currentTick<(game.nextBotTick??0))continue;
    if(game.state.players[game.state.current]?.id.startsWith('bot:')) {
      try { multiBotAction(key,game); } catch(error) { game.nextBotTick=system.currentTick+20; console.warn(`Multiplayer bot: ${error}`); }
    }
  }
  for (const p of world.getAllPlayers()) {
    const seat = seats.get(p.id), snap = runtime.current(p.id);
    try {
      if (system.currentTick % 100 < 5) {
        try { display.prune(p.dimension,p.location); } catch (error) { console.warn(`Roulette display cleanup: ${error}`); }
      }
      if (!seat || !snap) {
        const multi = multiSeats.get(p.id);
        if (multi) {
          if (p.dimension.id!==multi.table.dimension.id || distance(p.location,multi.spot)>.35 || !tableIntact(multi.table)) {
            leaveMultiSeat(p,multi.table.key);
            const events=multiStep(multi.table.key,{type:'playerLeft',playerId:p.id});
            if(events)multiBroadcast(multi.table.key,events);
            recover(p);
          }
          continue;
        }
        recover(p); continue;
      }
      if (p.dimension.id !== seat.table.dimension.id || distance(seat.stealSpot ?? seat.spot,p.location) > .35 || !tableIntact(seat.table)) {
        leave(p,'已离座，进度已保留。');
        continue;
      }
      const now = system.currentTick, ticks = now-seat.lastClock;
      if (snap.state.phase === 'ended' && seat.step?.finishOnBlack && now >= seat.stepUntil) {
        finish(p,snap);
        continue;
      }
      if (seat.notice && now >= seat.noticeUntil) {
        seat.notice = undefined;
        tell(p,'');
      }
      const cinematic = advanceScenes(p,seat,now);
      if (!cinematic && seat.noticeAfterScene) {
        announce(p,seat,seat.noticeAfterScene);
        seat.noticeAfterScene = undefined;
      }
      let dealerMove;
      if (!cinematic && snap.state.phase === 'dealerTurn') {
        if (seat.dealerWait !== undefined) {
          seat.next = now + seat.dealerWait;
          seat.dealerWait = undefined;
        }
        if (now >= seat.next) {
          dealerMove = dealerAction(snap.state);
          if (dealerMove?.move === 'shoot') seat.dealerDrawUntil ??= now + DEALER_DRAW_DELAY;
        }
      }
      updateStealVision(p,seat,seat.step?.highlight === true ||
        (snap.state.phase === 'steal' && (!cinematic || seat.step?.name === 'steal')));
      try {
        const hit = cinematic ? null : feltHit(seat.table,p.getBlockFromViewDirection({maxDistance:8}),p.getHeadLocation?.(),p.getViewDirection?.());
        const scene = seat.step ?? (seat.dealerDrawUntil !== undefined ? {gun:0} : undefined);
        display.update(seat.table,snap.state,hit,scene);
        aimLabels.update(p,seat.table,snap.state,cinematic ? null : hit);
      } catch (error) {
        if (!seat.displayWarning) {
          console.warn(`Roulette display: ${error}`);
          seat.displayWarning = true;
        }
      }
      if (cinematic) {
        seat.lastClock = now;
        
        continue;
      }
      if (ticks >= 20) {
        seat.lastClock = now;
        if ((snap.state.group === 1 && snap.state.phase !== 'double' && snap.state.elapsedTicks < 20997) || snap.state.phase === 'steal') {
          act(p,{type:'tick',ticks});
          if (runtime.current(p.id)?.state.phase !== snap.state.phase) continue;
        }
      }
      if (snap.state.phase === 'double' && !seat.doubleMenuShown && !menus.has(p.id) && now >= (seat.doubleMenuRetryAt ?? 0)) {
        seat.doubleMenuShown = true;
        void menu(p,seat.table).then(reason => {
          if (reason === 'UserBusy' && seats.get(p.id) === seat && runtime.current(p.id)?.state.phase === 'double') {
            seat.doubleMenuShown = false;
            seat.doubleMenuRetryAt = system.currentTick + 20;
          }
        });
      }
      if (now < seat.next) continue;
      if (snap.state.phase === 'loadReveal') act(p,{type:'advance'});
      else if (dealerMove && (dealerMove.move !== 'shoot' || now >= seat.dealerDrawUntil)) act(p,dealerMove); else if (snap.state.phase === 'ended' && !playingScene(seat)) finish(p,snap);
    } catch (error) {
      leave(p,'对局运行异常，进度已保留。');
      console.warn(`Roulette tick: ${error}`);
    }
  }
},5);
