/**
 * Argument validation for the combat-testing tools (read-chat-log,
 * manage-combat, apply-to-token, build-nimble-character) and use-item's
 * Nimble autoRoll options. Bad calls must never reach the bridge.
 */

import { describe, it, expect, vi } from 'vitest';
import { CombatTestingTools } from './combat-testing.js';
import { NimbleCharacterBuilderTools } from './nimble/character-builder.js';
import { CharacterTools } from './character.js';

function makeDeps(result: unknown = { ok: true }) {
  const query = vi.fn(async () => result);
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  return { foundryClient: { query } as any, logger, query };
}

describe('read-chat-log', () => {
  it('applies defaults', async () => {
    const deps = makeDeps();
    await new CombatTestingTools(deps).handleReadChatLog({});
    expect(deps.query).toHaveBeenCalledWith('foundry-mcp-bridge.readChatLog', {
      limit: 20,
      includeRolls: true,
    });
  });

  it('converts an ISO sinceTimestamp to ms', async () => {
    const deps = makeDeps();
    await new CombatTestingTools(deps).handleReadChatLog({
      sinceTimestamp: '2026-10-08T10:00:00Z',
    });
    expect(deps.query).toHaveBeenCalledWith(
      'foundry-mcp-bridge.readChatLog',
      expect.objectContaining({ sinceTimestamp: Date.parse('2026-10-08T10:00:00Z') })
    );
  });

  it('rejects bad limits, bad timestamps and both since filters', async () => {
    const deps = makeDeps();
    const tools = new CombatTestingTools(deps);
    await expect(tools.handleReadChatLog({ limit: 0 })).rejects.toThrow();
    await expect(tools.handleReadChatLog({ limit: 500 })).rejects.toThrow();
    await expect(tools.handleReadChatLog({ sinceTimestamp: 'yesterday-ish' })).rejects.toThrow();
    await expect(
      tools.handleReadChatLog({ sinceMessageId: 'abc', sinceTimestamp: 5 })
    ).rejects.toThrow(/not both/);
    expect(deps.query).not.toHaveBeenCalled();
  });
});

describe('manage-combat', () => {
  const make = () => {
    const deps = makeDeps();
    return { ...deps, tools: new CombatTestingTools(deps) };
  };

  it('create requires tokens', async () => {
    const { tools, query } = make();
    await expect(tools.handleManageCombat({ action: 'create' })).rejects.toThrow();
    await expect(tools.handleManageCombat({ action: 'create', tokens: [] })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('create forwards scene and tokens', async () => {
    const { tools, query } = make();
    await tools.handleManageCombat({ action: 'create', scene: 'Arena', tokens: ['Hero', 'tokA'] });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageCombat', {
      action: 'create',
      scene: 'Arena',
      tokens: ['Hero', 'tokA'],
    });
  });

  it('end requires confirm: true', async () => {
    const { tools, query } = make();
    await expect(tools.handleManageCombat({ action: 'end' })).rejects.toThrow(/confirm/);
    await expect(tools.handleManageCombat({ action: 'end', confirm: false })).rejects.toThrow(
      /confirm/
    );
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['roll-initiative', 'start', 'next-turn', 'get'])('%s forwards', async action => {
    const { tools, query } = make();
    await tools.handleManageCombat({ action });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageCombat', { action });
  });

  it('rejects unknown actions', async () => {
    const { tools, query } = make();
    await expect(tools.handleManageCombat({ action: 'flee' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('apply-to-token', () => {
  const make = () => {
    const deps = makeDeps();
    return { ...deps, tools: new CombatTestingTools(deps) };
  };

  it('raw mode needs tokens, amount and kind', async () => {
    const { tools, query } = make();
    await expect(tools.handleApplyToToken({ amount: 5, kind: 'damage' })).rejects.toThrow(/tokens/);
    await expect(tools.handleApplyToToken({ tokens: ['a'], kind: 'damage' })).rejects.toThrow(
      /amount/
    );
    await expect(tools.handleApplyToToken({ tokens: ['a'], amount: 5 })).rejects.toThrow(/kind/);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects bad kind and non-positive amounts', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleApplyToToken({ tokens: ['a'], amount: 5, kind: 'poison' })
    ).rejects.toThrow();
    await expect(
      tools.handleApplyToToken({ tokens: ['a'], amount: 0, kind: 'damage' })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('chat-card mode refuses an explicit amount', async () => {
    const { tools, query } = make();
    await expect(tools.handleApplyToToken({ fromChatMessageId: 'm1', amount: 5 })).rejects.toThrow(
      /chat card/
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('forwards valid calls in both modes', async () => {
    const { tools, query } = make();
    await tools.handleApplyToToken({ tokens: ['Hero'], amount: 4, kind: 'tempHealing' });
    await tools.handleApplyToToken({ fromChatMessageId: 'm1', kind: 'damage' });
    expect(query).toHaveBeenNthCalledWith(1, 'foundry-mcp-bridge.applyToToken', {
      tokens: ['Hero'],
      amount: 4,
      kind: 'tempHealing',
    });
    expect(query).toHaveBeenNthCalledWith(2, 'foundry-mcp-bridge.applyToToken', {
      fromChatMessageId: 'm1',
      kind: 'damage',
    });
  });
});

describe('build-nimble-character', () => {
  const base = {
    name: 'Test Shepherd',
    ancestry: 'Human',
    background: 'Survivalist',
    className: 'Shepherd',
    level: 3,
  };
  const make = () => {
    const deps = makeDeps();
    return { ...deps, tools: new NimbleCharacterBuilderTools(deps) };
  };

  it('applies defaults and forwards', async () => {
    const { tools, query } = make();
    await tools.handleBuildCharacter({ ...base, statArray: 'standard' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.buildNimbleCharacter', {
      ...base,
      statArray: 'standard',
      folder: 'AI Test',
      startingEquipment: true,
    });
  });

  it('rejects missing required fields and bad levels', async () => {
    const { tools, query } = make();
    await expect(tools.handleBuildCharacter({ ...base, className: undefined })).rejects.toThrow();
    await expect(tools.handleBuildCharacter({ ...base, level: 0 })).rejects.toThrow();
    await expect(tools.handleBuildCharacter({ ...base, level: 21 })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a subclass below level 3', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleBuildCharacter({ ...base, level: 2, subclass: 'Flock of Ash' })
    ).rejects.toThrow(/level 3/);
    expect(query).not.toHaveBeenCalled();
  });

  it('validates the stat assignment', async () => {
    const { tools, query } = make();
    await expect(tools.handleBuildCharacter({ ...base, statArray: 'heroic' })).rejects.toThrow();
    await expect(
      tools.handleBuildCharacter({ ...base, statArray: 'standard', abilities: { strength: 2 } })
    ).rejects.toThrow(/not both/);
    await expect(
      tools.handleBuildCharacter({
        ...base,
        statArray: 'standard',
        abilityOrder: ['strength', 'strength', 'will', 'dexterity'],
      })
    ).rejects.toThrow(/once/);
    await expect(
      tools.handleBuildCharacter({
        ...base,
        abilityOrder: ['strength', 'dexterity', 'will', 'intelligence'],
      })
    ).rejects.toThrow(/statArray/);
    await expect(
      tools.handleBuildCharacter({ ...base, abilities: { charisma: 2 } })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('use-item autoRoll options', () => {
  const make = () => {
    const deps = makeDeps({ actorName: 'Kai', itemName: 'Stab' });
    return { ...deps, tools: new CharacterTools(deps) };
  };

  it('forwards autoRoll, advantage and rollHidden', async () => {
    const { tools, query } = make();
    await tools.handleUseItem({
      actorIdentifier: 'Kai',
      itemIdentifier: 'Stab',
      targets: ['Goblin'],
      autoRoll: true,
      advantage: -1,
      rollHidden: true,
    });
    expect(query).toHaveBeenCalledWith(
      'foundry-mcp-bridge.useItem',
      expect.objectContaining({
        targets: ['Goblin'],
        options: expect.objectContaining({ autoRoll: true, advantage: -1, rollHidden: true }),
      })
    );
  });

  it('keeps the old payload when autoRoll is absent', async () => {
    const { tools, query } = make();
    await tools.handleUseItem({ actorIdentifier: 'Kai', itemIdentifier: 'Stab' });
    const options = (query.mock.calls[0] as any)[1].options;
    expect(options).not.toHaveProperty('autoRoll');
    expect(options).not.toHaveProperty('advantage');
  });

  it('rejects advantage without autoRoll and out-of-range advantage', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleUseItem({ actorIdentifier: 'Kai', itemIdentifier: 'Stab', advantage: 1 })
    ).rejects.toThrow(/autoRoll/);
    await expect(
      tools.handleUseItem({
        actorIdentifier: 'Kai',
        itemIdentifier: 'Stab',
        autoRoll: true,
        advantage: 9,
      })
    ).rejects.toThrow();
    await expect(
      tools.handleUseItem({
        actorIdentifier: 'Kai',
        itemIdentifier: 'Stab',
        autoRoll: true,
        advantage: 0.5,
      })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
