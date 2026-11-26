// Multiplayer tabletop regions use half-open bounds; ties at the centre go clockwise
// by stable priority north, east, south, west.
const rotate = (turn,x,z) => [[x,z],[-z,x],[-x,-z],[z,-x]][turn];
const contains = ([l,t,r,b],x,z) => x >= l && x < r && z >= t && z < b;
const northSlots = [];
for (const x of [1.25,1.8125,2.625,3.1875]) for (const z of [.125,.6875]) northSlots.push([x,z,x+.5,z+.5]);
const rotateRect = (rect,turn) => {
  const [l,t,r,b]=rect;
  const p=[[l,t],[r,t],[l,b],[r,b]].map(([x,z])=>rotate(turn,x-2.5,z-2.5).map(v=>v+2.5));
  return [Math.min(...p.map(v=>v[0])),Math.min(...p.map(v=>v[1])),Math.max(...p.map(v=>v[0])),Math.max(...p.map(v=>v[1]))];
};
export const MULTI_SLOT_RECTS=Object.fromEntries([['north',0],['east',1],['south',2],['west',3]].map(([seat,t])=>[seat,northSlots.map(r=>rotateRect(r,t))]));
export const MULTI_GUN_RECT=[1.75,1.75,3.25,3.25];
export function multiPickRegion(x,z){
  for(const [seat,rects] of Object.entries(MULTI_SLOT_RECTS)){
    const slot=rects.findIndex(r=>contains(r,x,z));
    if(slot!==-1)return {kind:'slot',seat,slot};
  }
  if(contains(MULTI_GUN_RECT,x,z)) return {kind:'gun'};
  return null;
}
export function multiAimTargetAt(x,z){
  const dx=x-2.5,dz=z-2.5;
  if(Math.abs(dx)<=1.5&&Math.abs(dz)<=1.5)return null;
  if(Math.abs(dz)>=Math.abs(dx))return dz<0?'north':'south';
  return dx>0?'east':'west';
}
