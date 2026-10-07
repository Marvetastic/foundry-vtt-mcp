/**
 * Argument validation for manage-world-items get/delete, manage-journals and
 * check-level-up-grants. The document work runs browser-side; these cover the
 * MCP tool layer: bad calls are rejected before any bridge query is sent, and
 * valid calls forward to the right query.
 */

import { describe, it, expect, vi } from 'vitest';
import { CharacterTools } from './character.js';
import { JournalManagementTools } from './journal-management.js';
import { NimbleLevelUpGrantsTools } from './nimble/level-up-grants.js';

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

describe('manage-world-items get/delete', () => {
  it('advertises get and delete', () => {
    const { foundryClient, logger } = makeDeps();
    const def = new CharacterTools({ foundryClient, logger })
      .getToolDefinitions()
      .find(t => t.name === 'manage-world-items')!;
    const props = def.inputSchema.properties as any;
    expect(props.action.enum).toEqual(expect.arrayContaining(['get', 'delete']));
    expect(props.confirm).toBeDefined();
    expect(def.description).toContain('"delete"');
  });

  it('get forwards itemIds', async () => {
    const { foundryClient, logger, query } = makeDeps({ items: [], notFound: [] });
    const tools = new CharacterTools({ foundryClient, logger });
    await tools.handleManageWorldItems({ action: 'get', itemIds: ['abc'] });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.getWorldItems', { itemIds: ['abc'] });
  });

  it('get rejects missing or empty itemIds', async () => {
    const { foundryClient, logger, query } = makeDeps();
    const tools = new CharacterTools({ foundryClient, logger });
    await expect(tools.handleManageWorldItems({ action: 'get' })).rejects.toThrow();
    await expect(tools.handleManageWorldItems({ action: 'get', itemIds: [] })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('delete requires confirm: true', async () => {
    const { foundryClient, logger, query } = makeDeps();
    const tools = new CharacterTools({ foundryClient, logger });
    await expect(
      tools.handleManageWorldItems({ action: 'delete', itemIds: ['abc'] })
    ).rejects.toThrow(/confirm/);
    await expect(
      tools.handleManageWorldItems({ action: 'delete', itemIds: ['abc'], confirm: false })
    ).rejects.toThrow(/confirm/);
    await expect(
      tools.handleManageWorldItems({ action: 'delete', itemIds: ['abc'], confirm: 'true' })
    ).rejects.toThrow(/confirm/);
    expect(query).not.toHaveBeenCalled();
  });

  it('delete rejects missing ids', async () => {
    const { foundryClient, logger, query } = makeDeps();
    const tools = new CharacterTools({ foundryClient, logger });
    await expect(
      tools.handleManageWorldItems({ action: 'delete', itemIds: [], confirm: true })
    ).rejects.toThrow();
    await expect(
      tools.handleManageWorldItems({ action: 'delete', confirm: true })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('delete refuses compendium references', async () => {
    const { foundryClient, logger, query } = makeDeps();
    const tools = new CharacterTools({ foundryClient, logger });
    await expect(
      tools.handleManageWorldItems({
        action: 'delete',
        itemIds: ['abc', 'Compendium.nimble.nimble-classes.Item.xyz'],
        confirm: true,
      })
    ).rejects.toThrow(/Compendium/);
    expect(query).not.toHaveBeenCalled();
  });

  it('delete forwards a valid request', async () => {
    const { foundryClient, logger, query } = makeDeps({ deleted: [], notFound: [] });
    const tools = new CharacterTools({ foundryClient, logger });
    await tools.handleManageWorldItems({ action: 'delete', itemIds: ['abc'], confirm: true });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.deleteWorldItems', {
      itemIds: ['abc'],
      confirm: true,
    });
  });
});

describe('manage-journals', () => {
  const make = (result?: unknown) => {
    const deps = makeDeps(result);
    return { ...deps, tools: new JournalManagementTools(deps) };
  };

  it('create defaults visibility to gm', async () => {
    const { tools, query } = make();
    await tools.handleManageJournals({
      action: 'create',
      name: 'Lore',
      pages: [{ name: 'Intro', html: '<p>Hi</p>' }],
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageJournals', {
      action: 'create',
      name: 'Lore',
      pages: [{ name: 'Intro', html: '<p>Hi</p>' }],
      visibility: 'gm',
    });
  });

  it('create rejects a bad visibility', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleManageJournals({
        action: 'create',
        name: 'Lore',
        pages: [{ name: 'Intro', html: '' }],
        visibility: 'everyone',
      })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('create requires at least one page', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleManageJournals({ action: 'create', name: 'Lore', pages: [] })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('delete requires confirm: true', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleManageJournals({ action: 'delete', entryIds: ['j1'] })
    ).rejects.toThrow(/confirm/);
    expect(query).not.toHaveBeenCalled();
  });

  it('delete rejects missing ids', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleManageJournals({ action: 'delete', entryIds: [], confirm: true })
    ).rejects.toThrow();
    await expect(tools.handleManageJournals({ action: 'delete', confirm: true })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('delete refuses compendium journals', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleManageJournals({
        action: 'delete',
        entryIds: ['Compendium.world.lore.JournalEntry.abc'],
        confirm: true,
      })
    ).rejects.toThrow(/Compendium/);
    expect(query).not.toHaveBeenCalled();
  });

  it('update-page needs html or name', async () => {
    const { tools, query } = make();
    await expect(
      tools.handleManageJournals({ action: 'update-page', entry: 'j1', pageId: 'p1' })
    ).rejects.toThrow(/html and\/or name/);
    expect(query).not.toHaveBeenCalled();
  });

  it('append forwards entry, page and html', async () => {
    const { tools, query } = make();
    await tools.handleManageJournals({
      action: 'append',
      entry: 'Lore',
      pageId: 'p1',
      html: '<p>More</p>',
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.manageJournals', {
      action: 'append',
      entry: 'Lore',
      pageId: 'p1',
      html: '<p>More</p>',
    });
  });

  it('rejects unknown actions', async () => {
    const { tools, query } = make();
    await expect(tools.handleManageJournals({ action: 'purge' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('check-level-up-grants', () => {
  it('forwards valid input', async () => {
    const deps = makeDeps();
    const tools = new NimbleLevelUpGrantsTools(deps);
    await tools.handleCheckLevelUpGrants({ classIdentifier: 'shepherd', level: 3 });
    expect(deps.query).toHaveBeenCalledWith('foundry-mcp-bridge.checkNimbleLevelUpGrants', {
      classIdentifier: 'shepherd',
      level: 3,
    });
  });

  it('rejects missing class or out-of-range level', async () => {
    const deps = makeDeps();
    const tools = new NimbleLevelUpGrantsTools(deps);
    await expect(tools.handleCheckLevelUpGrants({ level: 3 })).rejects.toThrow();
    await expect(
      tools.handleCheckLevelUpGrants({ classIdentifier: 'shepherd', level: 0 })
    ).rejects.toThrow();
    await expect(
      tools.handleCheckLevelUpGrants({ classIdentifier: 'shepherd', level: 2.5 })
    ).rejects.toThrow();
    expect(deps.query).not.toHaveBeenCalled();
  });
});
