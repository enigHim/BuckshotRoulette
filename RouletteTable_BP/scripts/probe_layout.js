import { LAYOUT } from './layout_data.js';

const TURN = 'roulette_table:table_turn';
const PREFIX = 'roulette_table:rlt_table_';

export function rotate(turn, x, z) {
  return [[x,z],[-z,x],[-x,-z],[z,-x]][turn];
}

const MULTI_PREFIX = 'roulette_table:multi_table_';

export function tableAt(block) {
  const single = /^roulette_table:rlt_table_([0-2])_([0-3])$/.exec(block?.typeId ?? '');
  const multi = /^roulette_table:multi_table_([0-4])_([0-4])$/.exec(block?.typeId ?? '');
  if (!single && !multi) return null;
  const isMulti = !!multi;
  const match = multi || single;
  const turn = isMulti ? 0 : block.permutation.getState(TURN);
  if (!Number.isInteger(turn) || turn < 0 || turn > 3) return null;
  const dx = +match[1] - (isMulti ? 2 : 2);
  const dz = +match[2] - (isMulti ? 2 : 3);
  const [ox,oz] = rotate(turn,dx,dz);
  const { x,y,z } = block.location;
  const dimension = block.dimension;
  return { multi:isMulti, turn, origin:{x:x-ox,y,z:z-oz}, dimension,
    key:`${dimension.id}:${x-ox}:${y}:${z-oz}:${turn}:${isMulti?'multi':'single'}` };
}

export function tableIntact(table) {
  const size = table.multi ? 5 : 3;
  const rows = table.multi ? 5 : 4;
  const prefix = table.multi ? MULTI_PREFIX : PREFIX;
  for (let c=0;c<size;c++) for (let r=0;r<rows;r++) {
    const [x,z] = rotate(table.turn,c-(table.multi?2:2),r-(table.multi?2:3));
    const block = table.dimension.getBlock({x:table.origin.x+x,y:table.origin.y,z:table.origin.z+z});
    const id = `${prefix}${c}_${r}`;
    if (block?.typeId !== id || (!table.multi && block.permutation.getState(TURN) !== table.turn)) return false;
  }
  return true;
}

export const SEAT_INSET = LAYOUT.seatInset;
export const STEAL_ADVANCE = 2;

export function multiSeatAt(table, seat) {
  const spots = {south:[2.5,5.35], north:[2.5,-.35], east:[5.35,2.5], west:[-.35,2.5]};
  const [x,z] = spots[seat] ?? spots.south;
  return tableToWorld(table,x,0,z);
}

export function seatAt(table) {
  return table.multi ? multiSeatAt(table,'south') : tableToWorld(table,1.5,0,4.5-SEAT_INSET);
}

// Full-height vanilla ground blocks do not need a raycast to establish support.
const FULL_GROUND = new Set([
  'minecraft:sand','minecraft:red_sand','minecraft:gravel','minecraft:dirt',
  'minecraft:grass_block','minecraft:stone','minecraft:cobblestone','minecraft:sandstone',
  'minecraft:red_sandstone','minecraft:deepslate','minecraft:bedrock',
  'minecraft:glass','minecraft:tinted_glass','minecraft:hard_glass','minecraft:log','minecraft:log2',
]);

// Some full cubes are skipped by the block raycast, so accept these vanilla
// families by ID. The stable Script API does not expose block collision boxes.
const VANILLA_FULL_CUBE = /^minecraft:(?:(?:[a-z_]+_)?(?:stained_glass|double_slab)|(?:stripped_)?(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(?:log|wood)|(?:stripped_)?(?:crimson|warped)_(?:stem|hyphae))$/;
const PARTIAL_SUPPORT = /(?:^|[:_])(?:slab[0-9]*|stairs|pane|fence|wall|trapdoor|bars|piston_arm_collision)$/;
const SUPPORT_ERROR = '座位脚下没有完整方块';
const SUPPORT_CORNERS = [[.03125,.03125],[.96875,.03125],[.03125,.96875],[.96875,.96875]];

export function seatIssue(dimension, spot) {
  const x = Math.floor(spot.x), z = Math.floor(spot.z), y = spot.y;
  try {
    const feet = dimension.getBlock({x,y,z});
    const head = dimension.getBlock({x,y:y+1,z});
    if (!feet || !head) return '座位区块尚未加载。';
    if (!feet.isAir || !head.isAir) return '座位上方需要两格净空。';
    const ground = dimension.getBlock({x,y:y-1,z});
    if (!ground) return `座位脚下的区块未加载 (${x}, ${y-1}, ${z})。`;
    if (ground.isAir || ground.isLiquid) return SUPPORT_ERROR;
    const type = ground.typeId ?? '';
    if (FULL_GROUND.has(type) || VANILLA_FULL_CUBE.test(type)) return null;
    if (PARTIAL_SUPPORT.test(type)) return SUPPORT_ERROR;
    // Unknown blocks must hit the same top face at the centre and four corners.
    // A single ray through the seat can mistake a narrow support for a full block.
    for (const [dx,dz] of [[.5,.5],...SUPPORT_CORNERS]) {
      const hit = dimension.getBlockFromRay({x:x+dx,y:y+.25,z:z+dz},{x:0,y:-1,z:0},
        {maxDistance:2,includeLiquidBlocks:false,includePassableBlocks:false});
      const base = hit?.block?.location;
      const top = hit?.faceLocation?.y;
      if (!base || base.x !== x || base.y !== y-1 || base.z !== z || hit.face !== 'Up' ||
          !Number.isFinite(top) || Math.abs(top-1) > .01) return SUPPORT_ERROR;
    }
    return null;
  } catch (error) {
    console.warn(`Roulette seat check: ${error}`);
    return '暂时无法检查座位，请靠近后重试。';
  }
}

export function tableToWorld(table, x, y, z) {
  const [dx,dz] = rotate(table.turn,x-2.5,z-(table.multi ? 2.5 : 3.5));
  return { x:table.origin.x+.5+dx,y:table.origin.y+y,z:table.origin.z+.5+dz };
}

export function worldToTable(table, {x,y,z}) {
  const [dx,dz] = rotate((4-table.turn)%4,x-table.origin.x-.5,z-table.origin.z-.5);
  return {x:dx+2.5,y:y-table.origin.y,z:dz+(table.multi ? 2.5 : 3.5)};
}

const { tileTexels, felt, slots, gun, table: footprint, midline } = LAYOUT;
const u = v => (felt.offset[0]+.5+Math.round(v*(felt.dimensions[0]-1)))/tileTexels;
const w = v => (felt.offset[1]+.5+Math.round(v*(felt.dimensions[1]-1)))/tileTexels;
const halves = ([a,b], transform) => [a,(a+b)/2,b].map(transform);
export const SLOT_RECTS = Object.fromEntries(['dealer','player'].map(side => [side,
  slots.columns.flatMap(column => {
    const [x0,x1,x2] = halves(column,u);
    const [z0,z1,z2] = halves(slots[side],w);
    return [[x0,z0,x1,z1],[x1,z0,x2,z1],[x0,z1,x1,z2],[x1,z1,x2,z2]];
  }),
]));
export const GUN_RECT = gun;
export const FELT_HEIGHT = felt.top/16;
const contains = ([l,t,r,b],x,z) => x >= l && x < r && z >= t && z < b;

export function aimRegion(x,z) {
  if (!contains(footprint,x,z)) return null;
  return z < midline ? 'opponent' : 'self';
}

export function pickRegion(x,z) {
  for (const side of ['dealer','player']) {
    const slot = SLOT_RECTS[side].findIndex(rect => contains(rect,x,z));
    if (slot !== -1) return { kind:'slot', side, slot };
  }
  return contains(gun,x,z) ? {kind:'gun'} : null;
}

export const AIM_LABELS = {opponent:'庄家', self:'你'};
// A billboard raised above the felt appears shifted toward the far side while the
// player looks down, so the anchor is pushed toward the player to cancel it exactly.
export const AIM_LABEL_HEIGHT = FELT_HEIGHT + .38;
const EYE_ABOVE_FELT = 1.62 - FELT_HEIGHT;
const SEAT_Z = 4.5 - SEAT_INSET;
const PARALLAX = .85;
// Centres of the two unit cells either side of the midline, inside the middle lane.
const AIM_LABEL_Z = {opponent:1.5, self:2.5};
const AIM_LABEL_LIFT = AIM_LABEL_HEIGHT - FELT_HEIGHT;

/** The one label that may be shown for this aim point, or null. */
export function aimLabel(state, local) {
  if (state?.phase !== 'aim' || !local) return null;
  const target = aimRegion(local.x,local.z);
  return target ? {target, text:AIM_LABELS[target]} : null;
}

/** Canonical z that makes the raised label read as if it sat on the target cell. */
export function aimLabelZ(target) {
  const wanted = AIM_LABEL_Z[target];
  const rise = AIM_LABEL_LIFT*PARALLAX/EYE_ABOVE_FELT;
  return SEAT_Z - (SEAT_Z - wanted)*(1 - rise);
}

export function aimLabelLocation(table, target) {
  return tableToWorld(table,1.5,AIM_LABEL_HEIGHT,aimLabelZ(target));
}

export function stealSlot(state, local) {
  if (state.phase !== 'steal' || !local) return null;
  const hit = pickRegion(local.x,local.z);
  if (hit?.kind !== 'slot' || hit.side !== 'dealer') return null;
  const item = state.dealer.items[hit.slot];
  return item && item !== 'adrenaline' ? hit.slot : null;
}

export function classify(x,z) {
  const hit = pickRegion(x,z);
  if (hit?.kind === 'slot') return `${hit.side === 'dealer' ? '恶魔' : '玩家'}道具 ${hit.slot+1}`;
  return hit?.kind === 'gun' ? '中央枪区' : '桌面非选区';
}

export function localHit(table, hit, direction) {
  if (!hit?.block || tableAt(hit.block)?.key !== table.key || hit.face !== 'Up') return null;
  const f = hit.faceLocation;
  if (!f || ![f.x,f.z].every(v=>Number.isFinite(v) && v>=-1e-6 && v<=1+1e-6)) return null;
  const {x,y,z} = hit.block.location;
  const height = Number.isFinite(f.y) ? y+f.y-table.origin.y : FELT_HEIGHT;
  const shift = FELT_HEIGHT-height;
  // The rim slices have a taller selection box than the visible felt.
  if (Math.abs(shift) > 1/16+1e-5) return null;
  let t = 0;
  if (direction && Math.abs(shift) > 1e-6) {
    if (![direction.x,direction.y,direction.z].every(Number.isFinite) || direction.y >= -.001) return null;
    t = shift/direction.y;
    if (Math.abs(t) > .75) return null;
  }
  return worldToTable(table,{x:x+f.x+(direction?.x ?? 0)*t,y:table.origin.y+FELT_HEIGHT,z:z+f.z+(direction?.z ?? 0)*t});
}

// First-person crosshair alignment on the seated Bedrock player. The board
// reference uses the same vertical calibration for its projected board ray.
const CROSSHAIR_EYE_OFFSET = .1;

export function feltHit(table, hit, eye, direction) {
  if (!eye || !direction) return localHit(table,hit,direction);
  if (hit?.block && tableAt(hit.block)?.key !== table.key) return null;
  if (![eye.x,eye.y,eye.z,direction.x,direction.y,direction.z].every(Number.isFinite) || direction.y >= -.001) return null;
  const y = table.origin.y+FELT_HEIGHT;
  const t = (y-(eye.y+CROSSHAIR_EYE_OFFSET))/direction.y;
  if (t < 0 || t > 8) return null;
  const local = worldToTable(table,{x:eye.x+direction.x*t,y,z:eye.z+direction.z*t});
  return contains(footprint,local.x,local.z) ? local : null;
}

export function probeHit(table, hit) {
  if (!hit?.block || tableAt(hit.block)?.key !== table.key) return '未命中本桌';
  const p = localHit(table,hit);
  if (!p) return `桌块 ${hit.face}`;
  return `${classify(p.x,p.z)} (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`;
}
