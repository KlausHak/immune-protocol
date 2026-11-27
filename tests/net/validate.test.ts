import { describe, expect, it } from 'vitest';
import { MAX_COMMANDS_PER_TURN, sanitizeBatch, sanitizeCommand } from '../../src/net/validate';

describe('sanitizeCommand', () => {
  it('forces the sender slot as playerId and strips unknown fields', () => {
    const c = sanitizeCommand({ type: 'move', playerId: 1, unitIds: [5, 6], target: { x: 3, y: 4, z: 9 }, evil: true, queue: true }, 2);
    expect(c).toEqual({ type: 'move', playerId: 2, unitIds: [5, 6], target: { x: 3, y: 4 }, queue: true });
  });
  it('accepts every command type in its valid form', () => {
    const ok = [
      { type: 'smart', unitIds: [1], target: { x: 1, y: 2 }, targetId: 3 },
      { type: 'attackMove', unitIds: [1], target: { x: 1, y: 2 } },
      { type: 'attack', unitIds: [1], targetId: 3 },
      { type: 'patrol', unitIds: [1], target: { x: 1, y: 2 } },
      { type: 'hold', unitIds: [1] }, { type: 'stop', unitIds: [1] }, { type: 'returnCargo', unitIds: [1] },
      { type: 'follow', unitIds: [1], targetId: 2 }, { type: 'gather', unitIds: [1], targetId: 2 }, { type: 'repair', unitIds: [1], targetId: 2 },
      { type: 'build', unitIds: [1], defId: 'hosp_ward', tile: { x: 10, y: 12 } },
      { type: 'ability', unitIds: [1], abilityId: 'uv_flare', target: { x: 1, y: 1 } },
      { type: 'train', buildingId: 4, defId: 'hosp_orderly' }, { type: 'cancelTrain', buildingId: 4, index: 0 }, { type: 'cancelTrain', buildingId: 4 },
      { type: 'research', buildingId: 4, upgradeId: 'up_x' }, { type: 'cancelResearch', buildingId: 4 },
      { type: 'setRally', buildingIds: [4], target: { x: 1, y: 1 } }, { type: 'buildingAbility', buildingId: 4, abilityId: 'emergency_supply' },
      { type: 'cancelConstruction', buildingId: 4 }, { type: 'surrender' },
    ];
    for (const raw of ok) expect(sanitizeCommand({ ...raw, playerId: 9 }, 1), raw.type).toMatchObject({ ...raw, playerId: 1 });
  });
  it('rejects malformed commands', () => {
    const bad: unknown[] = [
      null, 5, 'move', {}, { type: 'nuke' },
      { type: 'move', unitIds: [], target: { x: 1, y: 1 } },
      { type: 'move', unitIds: 'all', target: { x: 1, y: 1 } },
      { type: 'move', unitIds: [1.5], target: { x: 1, y: 1 } },
      { type: 'move', unitIds: [1], target: { x: Number.NaN, y: 1 } },
      { type: 'move', unitIds: [1], target: { x: 1e9, y: 1 } },
      { type: 'move', unitIds: new Array(1000).fill(1), target: { x: 1, y: 1 } },
      { type: 'attack', unitIds: [1] },
      { type: 'build', unitIds: [1], defId: 'hosp_ward', tile: { x: 1.5, y: 2 } },
      { type: 'build', unitIds: [1], defId: 'x'.repeat(500), tile: { x: 1, y: 2 } },
      { type: 'train', buildingId: -1, defId: 'a' },
      { type: 'cancelTrain', buildingId: 1, index: 99 },
    ];
    for (const raw of bad) expect(sanitizeCommand(raw, 1), JSON.stringify(raw)?.slice(0, 80)).toBeNull();
  });
  it('sanitizeBatch caps the batch size and counts rejects', () => {
    const many = Array.from({ length: MAX_COMMANDS_PER_TURN + 5 }, () => ({ type: 'stop', playerId: 1, unitIds: [1] }));
    expect(sanitizeBatch(many, 1)).toMatchObject({ rejected: 5 });
    expect(sanitizeBatch('nope', 1)).toEqual({ cmds: [], rejected: 1 });
    expect(sanitizeBatch([{ type: 'stop', unitIds: [1] }, { type: 'x' }], 2)).toEqual({ cmds: [{ type: 'stop', playerId: 2, unitIds: [1] }], rejected: 1 });
  });
});
