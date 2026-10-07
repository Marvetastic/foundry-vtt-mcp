import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundryDataAccess, resolveWorldDocumentIds } from './data-access.js';

function collection<T extends { id: string }>(docs: T[]) {
  return Object.assign([...docs], {
    get: (id: string) => docs.find(d => d.id === id),
  });
}

function setupFoundry(items: any[] = [], journals: any[] = []) {
  const deleteItems = vi.fn().mockResolvedValue([]);
  const deleteJournals = vi.fn().mockResolvedValue([]);
  vi.stubGlobal('Hooks', { on: vi.fn() });
  vi.stubGlobal('game', {
    ready: true,
    world: { id: 'world-1' },
    user: { id: 'user-1', name: 'GM', isGM: true },
    system: { id: 'nimble' },
    items: collection(items),
    journal: collection(journals),
  });
  vi.stubGlobal('Item', { deleteDocuments: deleteItems });
  vi.stubGlobal('JournalEntry', { deleteDocuments: deleteJournals });
  return { deleteItems, deleteJournals };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWorldDocumentIds', () => {
  it('accepts plain ids and world UUIDs', () => {
    expect(resolveWorldDocumentIds(['abc', 'Item.def'], 'Item')).toEqual(['abc', 'def']);
  });

  it('refuses compendium UUIDs and other references', () => {
    expect(() =>
      resolveWorldDocumentIds(['Compendium.nimble.nimble-classes.Item.abc'], 'Item')
    ).toThrow(/compendium/);
    expect(() => resolveWorldDocumentIds(['Actor.abc.Item.def'], 'Item')).toThrow(/not a world/);
  });

  it('refuses empty input', () => {
    expect(() => resolveWorldDocumentIds([], 'Item')).toThrow();
    expect(() => resolveWorldDocumentIds(undefined, 'Item')).toThrow();
  });
});

describe('deleteWorldItems', () => {
  it('requires confirm: true', async () => {
    const { deleteItems } = setupFoundry([{ id: 'a', name: 'A' }]);
    const da = new FoundryDataAccess();
    await expect(da.deleteWorldItems({ itemIds: ['a'] })).rejects.toThrow(/confirm/);
    expect(deleteItems).not.toHaveBeenCalled();
  });

  it('refuses compendium references without deleting anything', async () => {
    const { deleteItems } = setupFoundry([{ id: 'a', name: 'A' }]);
    const da = new FoundryDataAccess();
    await expect(
      da.deleteWorldItems({
        itemIds: ['a', 'Compendium.nimble.nimble-classes.Item.x'],
        confirm: true,
      })
    ).rejects.toThrow(/compendium/);
    expect(deleteItems).not.toHaveBeenCalled();
  });

  it('refuses a document that reports a pack', async () => {
    const { deleteItems } = setupFoundry([{ id: 'a', name: 'Packed', pack: 'nimble.x' }]);
    const da = new FoundryDataAccess();
    await expect(da.deleteWorldItems({ itemIds: ['a'], confirm: true })).rejects.toThrow(
      /compendium/
    );
    expect(deleteItems).not.toHaveBeenCalled();
  });

  it('deletes world items and reports names and missing ids', async () => {
    const { deleteItems } = setupFoundry([{ id: 'a', name: 'A' }]);
    const da = new FoundryDataAccess();
    const result = await da.deleteWorldItems({ itemIds: ['a', 'missing'], confirm: true });
    expect(deleteItems).toHaveBeenCalledWith(['a']);
    expect(result).toEqual({ deleted: [{ id: 'a', name: 'A' }], notFound: ['missing'] });
  });
});

describe('deleteJournals', () => {
  it('requires confirm and refuses compendium journals', async () => {
    const { deleteJournals } = setupFoundry([], [{ id: 'j', name: 'J' }]);
    const da = new FoundryDataAccess();
    await expect(da.deleteJournals({ entryIds: ['j'] })).rejects.toThrow(/confirm/);
    await expect(
      da.deleteJournals({ entryIds: ['Compendium.world.lore.JournalEntry.j'], confirm: true })
    ).rejects.toThrow(/compendium/);
    expect(deleteJournals).not.toHaveBeenCalled();
  });

  it('deletes world journals', async () => {
    const { deleteJournals } = setupFoundry([], [{ id: 'j', name: 'J' }]);
    const da = new FoundryDataAccess();
    const result = await da.deleteJournals({ entryIds: ['JournalEntry.j'], confirm: true });
    expect(deleteJournals).toHaveBeenCalledWith(['j']);
    expect(result.deleted).toEqual([{ id: 'j', name: 'J' }]);
  });
});
