import { BlockPermutation, GameMode, ItemStack, system, world } from "@minecraft/server";

const NS = "roulette_table:";
const ITEM = NS + "table_placer";
const TURN = NS + "table_turn";
const CELLS = Array.from({ length: 12 }, (_, i) => {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return { id: `${NS}rlt_table_${col}_${row}`, dx: col - 2, dz: row - 3 };
});
const MULTI_ITEM = NS + "multi_table_placer";
const MULTI_CELLS = Array.from({ length: 25 }, (_, i) => {
  const col = i % 5;
  const row = Math.floor(i / 5);
  return { id: `${NS}multi_table_${col}_${row}`, dx: col - 2, dz: row - 2 };
});
const TABLES = [
  { item: ITEM, cells: CELLS, rotating: true, size: "4×3" },
  { item: MULTI_ITEM, cells: MULTI_CELLS, rotating: false, size: "5×5" },
];
const BY_ID = new Map(TABLES.flatMap(table => table.cells.map(cell => [cell.id, { table, cell }])));

function rotate(turn, x, z) {
  switch (turn) {
    case 1: return [-z, x];
    case 2: return [-x, -z];
    case 3: return [z, -x];
    default: return [x, z];
  }
}

function target(dim, origin, turn, cell) {
  const [x, z] = rotate(turn, cell.dx, cell.dz);
  return dim.getBlock({ x: origin.x + x, y: origin.y, z: origin.z + z });
}

function refund(player, dim, p, itemId) {
  if (player.getGameMode() === GameMode.Creative) return;
  const item = new ItemStack(itemId);
  const inventory = player.getComponent("minecraft:inventory")?.container;
  const overflow = inventory ? inventory.addItem(item) : item;
  if (overflow) dim.spawnItem(overflow, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
}

world.afterEvents.playerPlaceBlock.subscribe(({ block, player }) => {
  const table = TABLES.find(entry => entry.item === block.typeId);
  if (!table) return;
  system.run(() => {
    const dim = block.dimension;
    const p = block.location;
    const turn = table.rotating ? (Math.round(player.getRotation().y / 90) + 6) % 4 : 0;
    const changes = [];
    try {
      const targets = table.cells.map(cell => ({ cell, block: target(dim, p, turn, cell) }));
      const obstruction = targets.find(({ cell, block: tile }) => {
        const center = cell.dx === 0 && cell.dz === 0;
        const expected = center ? table.item : 'minecraft:air';
        return !tile || (tile.typeId !== expected && !(center && tile.typeId === cell.id));
      });
      if (!obstruction) {
        const plan = targets.map(({ cell, block: tile }) => ({
          tile, old: tile.permutation, next: table.rotating
            ? BlockPermutation.resolve(cell.id, { [TURN]: turn })
            : BlockPermutation.resolve(cell.id),
        }));
        for (const change of plan) {
          change.tile.setPermutation(change.next);
          changes.push(change);
        }
        return;
      }
      console.warn(`RouletteTable obstruction: ${obstruction.cell.id} at ${obstruction.block?.location?.x},${obstruction.block?.location?.y},${obstruction.block?.location?.z} is ${obstruction.block?.typeId ?? 'unloaded'}`);
    } catch (error) {
      for (const { tile, old } of changes.reverse()) {
        try { tile.setPermutation(old); } catch (rollbackError) { console.warn(String(rollbackError)); }
      }
      console.warn(`RouletteTable placement: ${error}`);
    }
    if (block.typeId === table.item) block.setType('minecraft:air');
    refund(player, dim, p, table.item);
    player.onScreenDisplay.setActionBar(`§c牌桌需要留出完整的 ${table.size} 格空间。`);
  });
});

world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation }) => {
  const match = BY_ID.get(brokenBlockPermutation.type.id);
  if (!match) return;
  const { table, cell } = match;
  const turn = table.rotating ? brokenBlockPermutation.getState(TURN) : 0;
  const [dx, dz] = rotate(turn, cell.dx, cell.dz);
  const dim = block.dimension;
  const p = block.location;
  const origin = { x: p.x - dx, y: p.y, z: p.z - dz };
  for (const part of table.cells) {
    try {
      const tile = target(dim, origin, turn, part);
      if (tile?.typeId === part.id && (!table.rotating || tile.permutation.getState(TURN) === turn)) tile.setType("minecraft:air");
    } catch (error) {
      console.warn(`RouletteTable removal: ${error}`);
    }
  }
});

import "./game_runtime.js";
