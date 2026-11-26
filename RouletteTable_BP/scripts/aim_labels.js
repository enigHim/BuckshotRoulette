// 3D world text labels for the aiming phase, one per seated player.
//
// Uses the beta TextPrimitive API (Minecraft 1.26.20+): one shape is created per
// player, then only retargeted or removed, so the manager never accumulates shapes.
import * as mc from '@minecraft/server';
import { aimLabel, aimLabelLocation, FELT_HEIGHT, pickRegion, stealSlot, STEAL_ADVANCE, tableToWorld } from './probe_layout.js';
import { ITEM_NAMES } from './game_rules.js';

const SCALE = .7;
const TOOLTIP_Z = 3.58;
const TOOLTIP_LAYOUT = [[.319,.66],[.182,.48],[.182,.36]];
const GUN_TOOLTIP = ['霰弹枪','用空包弹射击自己','会使庄家此回合无法行动。'];
const ITEM_HINTS = {
  magnifier: ['检查弹膛中','当前的子弹。'],
  beer: ['弹出霰弹枪膛内','当前的子弹。'],
  cuffs: ['庄家下一回合','无法行动。'],
  saw: ['霰弹枪造成 2 点伤害。'],
  cigarette: ['消除压力。','恢复 1 点生命值。'],
  adrenaline: ['偷窃一件物品','并立即使用。'],
  inverter: ['切换弹膛内当前子弹为实弹或空包弹。'],
  phone: ['一个神秘的声音','让你窥探未来。'],
  expired: ['有 50% 的几率恢复 2 点生命值。','否则将损失 1 点生命值。'],
};

/** Owns one text primitive per seated player. Requires the Beta APIs experiment. */
export function createAimLabels(world) {
  const shapes = new Map();
  const tooltips = new Map();
  const manager = () => world.primitiveShapesManager;

  function remove(playerId) {
    const lines = tooltips.get(playerId) ?? [];
    tooltips.delete(playerId);
    for (const line of lines) {
      try { line.remove(); } catch (error) { console.warn(`Roulette gun label removal: ${error}`); }
    }
    const shape = shapes.get(playerId);
    if (!shape) return;
    shapes.delete(playerId);
    try { shape.remove(); } catch (error) { console.warn(`Roulette aim label removal: ${error}`); }
  }

  function clearAll() {
    for (const playerId of new Set([...shapes.keys(),...tooltips.keys()])) remove(playerId);
  }

  /**
   * Show exactly one label, or none. Returns true when a label is on screen.
   * Silently does nothing when the beta API is unavailable so play still works.
   */
  function update(player, table, state, local) {
    const region = local && pickRegion(local.x,local.z);
    const playerTurn = ['playerTurn','itemSelected'].includes(state?.phase);
    const stolenSlot = state && stealSlot(state,local);
    const item = playerTurn && region?.side === 'player' ? state.player?.items[region.slot]
      : state?.phase === 'steal' && stolenSlot !== null ? state.dealer.items[stolenSlot] : null;
    const tooltip = playerTurn && region?.kind === 'gun' ? GUN_TOOLTIP
      : ITEM_HINTS[item] ? [ITEM_NAMES[item],...ITEM_HINTS[item]] : null;
    if (tooltip) {
      const z = state.phase === 'steal' ? TOOLTIP_Z - STEAL_ADVANCE : TOOLTIP_Z;
      const current = tooltips.get(player.id);
      if (current?.length === tooltip.length) {
        try {
          for (const [i,line] of current.entries()) {
            if (line.text !== tooltip[i]) line.setText(tooltip[i]);
            const [,height] = TOOLTIP_LAYOUT[i];
            const position = tableToWorld(table,1.5,FELT_HEIGHT+height,z);
            if (line.location.x !== position.x || line.location.z !== position.z) {
              line.setLocation({...position,dimension:player.dimension});
            }
          }
          return true;
        } catch (error) {
          remove(player.id);
          console.warn(`Roulette tooltip: ${error}`);
          return false;
        }
      }
      remove(player.id);
      const lines = [];
      tooltips.set(player.id,lines);
      try {
        for (const [i,text] of tooltip.entries()) {
          const [scale,height] = TOOLTIP_LAYOUT[i];
          const location = tableToWorld(table,1.5,FELT_HEIGHT+height,z);
          const line = create(player,text,scale,location);
          if (!line) { remove(player.id); return false; }
          lines.push(line);
        }
        return true;
      } catch (error) {
        remove(player.id);
        console.warn(`Roulette gun label: ${error}`);
        return false;
      }
    }
    if (tooltips.has(player.id)) remove(player.id);
    const wanted = aimLabel(state,local);
    let shape = shapes.get(player.id);
    if (!wanted) {
      remove(player.id);
      return false;
    }
    try {
      if (!shape) {
        shape = create(player,wanted.text);
        if (!shape) return false;
        shapes.set(player.id,shape);
      } else if (shape.text !== wanted.text) {
        shape.setText(wanted.text);
      }
      shape.setLocation({...aimLabelLocation(table,wanted.target),dimension:player.dimension});
      return true;
    } catch (error) {
      console.warn(`Roulette aim label: ${error}`);
      remove(player.id);
      return false;
    }
  }

  function create(player, text, scale = SCALE, position = {x:0,y:0,z:0}) {
    const api = manager();
    const Ctor = mc.TextPrimitive;
    if (!api || typeof api.addText !== 'function' || typeof Ctor !== 'function') return null;
    const location = {...position,dimension:player.dimension};
    const shape = new Ctor(location,text);
    shape.useRotation = false;
    shape.backgroundColorOverride = {red:0,green:0,blue:0,alpha:0};
    shape.depthTest = true;
    shape.scale = scale;
    shape.visibleTo = [player];
    api.addText(shape,player.dimension);
    return shape;
  }

  return {update, remove, clearAll, count:() => shapes.size};
}
