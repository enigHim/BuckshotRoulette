import { ITEM_NAMES } from './game_rules.js';

const command = (label, type, payload = {}) => ({label, action:{type,...payload}});
const leave = () => ({label:'中断对局',route:'leave'});
const itemName = id => Object.hasOwn(ITEM_NAMES,id) ? ITEM_NAMES[id] : null;

/** Items keep their actual slot ids, including when intervening slots are empty. */
export function itemMenu(state) {
  const stealing = state?.phase === 'steal';
  if (!stealing && !['playerTurn','itemSelected'].includes(state?.phase)) return [];
  const side = stealing ? state.dealer : state.player;
  const entries = [];
  for (let slot=0;slot<8;slot++) {
    const id = side.items[slot];
    const name = itemName(id);
    if (!name || (stealing && id === 'adrenaline')) continue;
    entries.push(command(`${slot+1}. ${name}`,stealing ? 'steal' : 'useItem',{slot}));
  }
  if (stealing) entries.push(leave());
  return entries;
}

/** Idle tables and the leaderboard are handled by the runtime's entry menu. */
export function phaseMenu(state) {
  switch (state?.phase) {
    case 'collect': return [command('领取道具','collect'),leave()];
    case 'itemSelected': // Resume snapshots saved by earlier versions.
    case 'playerTurn': return [
      {label:'使用道具',route:'items'},command('选择射击','aim'),leave(),
    ];
    case 'aim': return [
      command('射击恶魔','shoot',{target:'opponent'}),command('射击自己','shoot',{target:'self'}),leave(),
    ];
    case 'steal': return itemMenu(state);
    case 'double': return [command('翻倍（继续挑战）','double',{yes:true}),command('收手兑现','double',{yes:false}),leave()];
    default: return [];
  }
}

const nameOf = side => side === 'player' ? '你' : '恶魔';
const shellName = shell => shell === 'live' ? '实弹' : '空包弹';

/** Audience: the seated player only. Never display a dealer-only observation. */
export function eventText(event) {
  if (!event || (event.privateTo && event.privateTo !== 'player')) return null;
  const actor = nameOf(event.by);
  switch (event.type) {
    case 'stageStart': return `第 ${event.group} 组 · 第 ${event.stage} 关`;
    case 'loadReveal': return `本次装填：实弹 ${event.live} · 空包弹 ${event.blank}`;
    case 'collected': return event.who === 'player' ? `已领取：${itemName(event.id) ?? '道具'}` : null;
    // The shot itself is carried by sound and the health counter, never by text.
    case 'shot': return null;
    case 'dead': return `${nameOf(event.who)}的电量耗尽`;
    case 'skip': return `${nameOf(event.who)}被手铐限制，跳过回合`;
    case 'eject': return `${actor}退掉一发${shellName(event.shell)}`;
    case 'cuffs': return `${actor}使用手铐，${nameOf(event.on)}的下一次行动被跳过`;
    case 'saw': return `${actor}锯短了枪管`;
    case 'hp': return `${actor}的电量：${event.hp}`;
    case 'invert': return `${actor}使用了${ITEM_NAMES.inverter}`;
    case 'peekAt':
      if (event.by !== 'player') return null;
      return event.index < 1
        ? `${ITEM_NAMES.phone}\n没有可查看的后续弹位。`
        : `第 ${event.index + 1} 发子弹\n……${shellName(event.shell)}。`;
    case 'stealPrompt': return '选择一件恶魔的道具';
    case 'stealUnavailable': return '恶魔没有可抢取的道具';
    case 'stealTimeout': return '抢取道具超时';
    case 'steal': return `${actor}抢取并使用了${itemName(event.id) ?? '道具'}`;
    case 'setClear': return `第 ${event.group} 组通关 · 可兑现 ${event.score}`;
    case 'end': return event.result === 'cashout' ? `已兑现：${event.score}` : '挑战失败';
    // Magnifier findings belong on the temporary close-up, not the action bar.
    default: return null;
  }
}

/** Public board state; no shell sequence, hidden queue entries or knowledge. */
export function statusText(state) {
  if (!state) return '';
  const board = `第 ${state.group} 组 · 第 ${state.stage} 关 | 电量 你 ${state.player.hp}/${state.maxHp} · 恶魔 ${state.dealer.hp}/${state.maxHp}`;
  let phase;
  switch (state.phase) {
    case 'loadReveal': phase = '准备本轮道具'; break;
    case 'collect': phase = '领取道具'; break;
    case 'playerTurn': phase = '你的回合'; break;
    case 'itemSelected': phase = `已选：${itemName(state.player.items[state.selectedSlot]) ?? '道具'}`; break;
    case 'aim': phase = '待射击'; break;
    case 'steal': phase = `选取恶魔的道具 · 剩余 ${Math.ceil(state.stealTicks/20)} 秒`; break;
    case 'dealerTurn': phase = '恶魔的回合'; break;
    case 'double': phase = `可兑现 ${state.score}`; break;
    case 'ended': phase = eventText({type:'end',result:state.result,score:state.score}); break;
    default: return '';
  }
  return `${board} | ${phase}`;
}
