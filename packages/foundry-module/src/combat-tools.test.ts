import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyToToken, manageCombat, resolveSceneTokens } from './combat-tools.js';

function scene(tokens: Array<{ id: string; name: string; actorName?: string }>) {
  const docs = tokens.map(t => ({
    ...t,
    uuid: `Scene.s1.Token.${t.id}`,
    actor: { name: t.actorName ?? t.name },
  }));
  return {
    id: 's1',
    name: 'Arena',
    tokens: Object.assign(docs, { get: (id: string) => docs.find(d => d.id === id) }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveSceneTokens', () => {
  const arena = scene([
    { id: 'tokA', name: 'Goblin' },
    { id: 'tokB', name: 'Goblin' },
    { id: 'tokC', name: 'Hero', actorName: 'Kai Veyl' },
  ]);

  it('resolves ids, token names and actor names', () => {
    expect(resolveSceneTokens(arena, ['tokA', 'hero', 'Kai Veyl']).map(t => t.id)).toEqual([
      'tokA',
      'tokC',
      'tokC',
    ]);
  });

  it('refuses ambiguous names and lists the ids', () => {
    expect(() => resolveSceneTokens(arena, ['Goblin'])).toThrow(/tokA.*tokB/);
  });

  it('errors on unknown tokens', () => {
    expect(() => resolveSceneTokens(arena, ['Dragon'])).toThrow(/not found/);
  });
});

describe('manageCombat', () => {
  it('end requires confirm and deletes nothing without it', async () => {
    const del = vi.fn();
    vi.stubGlobal('game', { combat: { id: 'c1', delete: del }, combats: {} });
    await expect(manageCombat({ action: 'end' })).rejects.toThrow(/confirm/);
    expect(del).not.toHaveBeenCalled();
  });

  it('end deletes only the combat document', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('game', { combat: { id: 'c1', delete: del }, combats: {} });
    await expect(manageCombat({ action: 'end', confirm: true })).resolves.toEqual({
      deleted: true,
      combatId: 'c1',
    });
    expect(del).toHaveBeenCalledOnce();
  });

  it('create requires tokens', async () => {
    vi.stubGlobal('game', {});
    await expect(manageCombat({ action: 'create' })).rejects.toThrow(/tokens/);
  });
});

describe('applyToToken', () => {
  it('is Nimble-only', async () => {
    vi.stubGlobal('game', { system: { id: 'dnd5e' } });
    await expect(applyToToken({ tokens: ['a'], amount: 3, kind: 'damage' })).rejects.toThrow(
      /Nimble/
    );
  });

  it('applies raw damage through the actor and reports before/after', async () => {
    const actor = {
      system: { attributes: { hp: { value: 10, max: 12, temp: 2 }, wounds: { value: 0, max: 6 } } },
      statuses: new Set<string>(),
      applyDamage: vi.fn(async function (this: any, amount: number) {
        const hp = actor.system.attributes.hp;
        const absorbed = Math.min(hp.temp, amount);
        hp.temp -= absorbed;
        hp.value -= amount - absorbed;
      }),
    };
    const arena = scene([{ id: 'tokA', name: 'Goblin' }]);
    (arena.tokens[0] as any).actor = actor;
    vi.stubGlobal('game', { system: { id: 'nimble' }, scenes: { active: arena } });
    vi.useFakeTimers();
    const pending = applyToToken({ tokens: ['tokA'], amount: 5, kind: 'damage' });
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();

    expect(actor.applyDamage).toHaveBeenCalledWith(5);
    expect(result.targets[0].before.hp).toEqual({ value: 10, max: 12, temp: 2 });
    expect(result.targets[0].after.hp).toEqual({ value: 7, max: 12, temp: 0 });
    expect(result.notes[0]).toMatch(/armor/);
  });
});
