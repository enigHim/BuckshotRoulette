import { tableToWorld, SEAT_INSET, FELT_HEIGHT, SLOT_RECTS } from './probe_layout.js';

// Positions and look targets in table-local blocks, calibrated for the 4x3 table.
const SHOTS = {
  home: [[1.5,1.55,4.48-SEAT_INSET],[1.5,.60,2]],
  dealer: [[1.42,1.38,3.55],[1.5,1.1,.16]],
  shells: [[1.82,1.34,2.85],[2.235,.60,2]],
  briefcase: [[1.46,1.42,3.98],[1.5,.60,3.34]],
  gun: [[1.95,1.18,2.86],[1.52,.64,1.82]],
  inspection: [[1.91,.94,2.17],[1.585,.629,1.933]],
  cuffs: [[1.59,1.25,1.39],[1.5,.70,.42]],
  playerCuffs: [[1.34,1.38,4.0],[.82,.61,3.74]],
  releaseCuffs: [[1.21,1.15,3.96],[.82,.61,3.74]],
  restoreProp: [[2.11,1.11,1.92],[1.51,.61,1.32]],
  health: [[1.52,1.24,2.45],[2.74,.80,2]],
  score: [[1.50,1.42,3.60],[2.74,.82,2]],
};

const HIT_FADE = {fadeInTime:.1,holdTime:1.15,fadeOutTime:.25};
const BLACKOUT_TICKS = Math.ceil(HIT_FADE.fadeInTime*20)+2;
export const DEFIB_CUE_TICKS = 10;
export const HIT_FADE_TICKS = Math.round(20*(HIT_FADE.fadeInTime+HIT_FADE.holdTime+HIT_FADE.fadeOutTime));

export function ammoReveal({live,blank}, random=Math.random) {
  const pattern = [...Array(live).fill('live'), ...Array(blank).fill('blank')];
  for (let i=pattern.length-1; i>0; i--) {
    const j = Math.floor(random()*(i+1));
    [pattern[i],pattern[j]] = [pattern[j],pattern[i]];
  }
  return {name:'shells',ticks:54,shells:{live,blank,pattern}};
}

export function cameraPlan(events, before) {
  const steps = [];
  const pan = (name,ticks=23,props={}) => steps.push({name,ticks,...props});
  const shot = events.find(e=>e.type==='shot');
  const dead = events.find(e=>e.type==='dead');
  const playerSkipped = events.some(e=>e.type==='skip' && e.who==='player');
  const cuffReleased = playerSkipped || (before?.cuffed?.player && events.some(e=>e.type==='loadReveal'));
  const previous = before ? {stage:before.stage,hp:{player:before.player.hp,dealer:before.dealer.hp}} : {};
  if (cuffReleased) previous.playerCuffed = true;
  if (shot) {
    const sawUsed = before?.sawActive === true;
    const impact = {...previous,hp:shot.hp,...(sawUsed ? {gun:2} : {})};
    if (shot.to==='player' && shot.damage>0) {
      const locked = {...impact,lockView:true};
      const fadeTicks = BLACKOUT_TICKS;
      if (shot.hp.player === 0) return [{...locked,fade:true,ticks:fadeTicks,finishOnBlack:true}];
      locked.highlight = true;
      steps.push({...locked,fade:true,ticks:fadeTicks,defibCue:true});
      pan('home',HIT_FADE_TICKS-fadeTicks+24,{...locked,instant:true,defib:true});
      pan('health',38,{...locked,healthCue:true});
    } else {
      pan(shot.by==='dealer' ? 'dealer' : 'gun',20,{...previous,gun:sawUsed ? 2 : 1,
        hideDealer:shot.to==='dealer' && shot.damage>0});
      if (shot.damage>0) pan('health',30,{...impact,healthCue:true});
    }
    if (sawUsed) {
      pan('restoreProp',16,{...impact,gun:2});
      pan('restoreProp',12,{...impact,gun:1,instant:true});
    }
  }
  if (cuffReleased) {
    if (playerSkipped) pan('playerCuffs',22,{playerCuffed:true});
    pan('releaseCuffs',16,{playerCuffed:true});
    pan('releaseCuffs',12,{playerCuffed:false,instant:true});
  }
  const theft = events.find(e=>e.type==='steal' && e.by==='dealer' && e.from==='player');
  const rect = SLOT_RECTS.player[theft?.slot];
  if (rect) {
    const [left,near,right,far] = rect;
    const x = (left+right)/2, z = (near+far)/2;
    const view = [[x+(x<1.5 ? .27 : -.27),1.38,z+.44],[x,FELT_HEIGHT+.025,z]];
    steps.push({view,ticks:16,holdItem:theft,stolenSlot:theft.slot},
      {view,ticks:14,instant:true,stolenSlot:theft.slot});
  }
  for (const e of events) {
    switch (e.type) {
      case 'loadReveal': break; // Announce the batch after collection, never on generation.
      case 'peek':
        if (e.privateTo==='player') pan('inspection',32,{peek:e.shell});
        if (e.by==='dealer' && e.privateTo==='dealer') {
          pan('dealer',16);
        }
        break;
      case 'eject': pan('inspection',23,{peek:e.shell}); break;
      case 'saw': pan('gun',22); break;
      case 'cuffs':
        if (e.on === 'player') pan('playerCuffs',25,{playerCuffed:true});
        else pan('cuffs',25);
        break;
      case 'hp': pan('health',28,{...previous,hp:{...previous.hp,[e.by]: e.hp}}); break;
      case 'setClear': pan('score',25); break;
      case 'end': if (!dead) pan('score',23); break;
    }
  }
  return steps;
}

export function entryPlan(state) {
  if (state.phase==='loadReveal') return [];
  return [];
}

// The stock free camera drops player effects (night vision, blindness), which made
// the scripted shots go dark. This preset inherits free and opts in.
export const FREE_CAMERA = 'roulette_table:free_player_effects';
const STOCK_FREE = 'minecraft:free';

export function setFreeCamera(player, options) {
  try {
    player.camera.setCamera(FREE_CAMERA, options);
  } catch (error) {
    console.warn(`Roulette camera preset: ${error}`);
    player.camera.setCamera(STOCK_FREE, options);
  }
}

export function playStep(player,table,step,markCamera) {
  if (step.fade) {
    player.camera.fade({fadeColor:{red:0,green:0,blue:0},fadeTime:HIT_FADE});
    return;
  }
  if (!step.name && !step.view) return;
  markCamera();
  const [from, toward] = step.view ?? SHOTS[step.name];
  const location = tableToWorld(table,...from);
  const facingLocation = tableToWorld(table,...toward);
  const options = {location,facingLocation};
  if (!step.instant) options.easeOptions = {easeTime:.6,easeType:'InOutSine'};
  setFreeCamera(player,options);
}
