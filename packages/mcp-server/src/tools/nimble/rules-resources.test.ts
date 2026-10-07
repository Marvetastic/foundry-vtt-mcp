/**
 * Argument validation for describe-nimble-rules, get-actor-resources,
 * use-reaction and rest. Bad calls must never reach the bridge.
 */

import { describe, it, expect, vi } from 'vitest';
import { NimbleRulesResourcesTools } from './rules-resources.js';

function makeTools(result: unknown = { ok: true }) {
  const query = vi.fn(async () => result);
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
  };
  return {
    tools: new NimbleRulesResourcesTools({ foundryClient: { query } as any, logger }),
    query,
  };
}

describe('tool definitions', () => {
  it('exposes the four tools', () => {
    const { tools } = makeTools();
    expect(tools.getToolDefinitions().map(t => t.name)).toEqual([
      'describe-nimble-rules',
      'get-actor-resources',
      'use-reaction',
      'rest',
    ]);
  });
});

describe('describe-nimble-rules', () => {
  it('passes an optional type through', async () => {
    const { tools, query } = makeTools();
    await tools.handleDescribeRules({ type: 'chargePool' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.describeNimbleRules', {
      type: 'chargePool',
    });
    await tools.handleDescribeRules({});
    expect(query).toHaveBeenLastCalledWith('foundry-mcp-bridge.describeNimbleRules', {});
  });

  it('accepts a rule to validate when its type is known', async () => {
    const { tools, query } = makeTools();
    await tools.handleDescribeRules({ validate: { type: 'chargePool', initial: 'full' } });
    await tools.handleDescribeRules({ type: 'chargePool', validate: { initial: 'full' } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects validate without a type, and an empty type', async () => {
    const { tools, query } = makeTools();
    await expect(tools.handleDescribeRules({ validate: { initial: 'full' } })).rejects.toThrow(
      /rule type/
    );
    await expect(tools.handleDescribeRules({ type: '' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('get-actor-resources', () => {
  it('requires an actor', async () => {
    const { tools, query } = makeTools();
    await expect(tools.handleGetActorResources({})).rejects.toThrow();
    await expect(tools.handleGetActorResources({ actor: '' })).rejects.toThrow(/actor is required/);
    expect(query).not.toHaveBeenCalled();
    await tools.handleGetActorResources({ actor: 'Brother Aldous' });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.getActorResources', {
      actor: 'Brother Aldous',
    });
  });
});

describe('use-reaction', () => {
  it('accepts an index or a label, with optional actor, force and spend', async () => {
    const { tools, query } = makeTools();
    await tools.handleUseReaction({ messageId: 'm1', offer: 0 });
    await tools.handleUseReaction({
      messageId: 'm1',
      offer: 'Interpose: Aura of Refuge — Brother Aldous',
      actor: 'Brother Aldous',
      force: true,
    });
    await tools.handleUseReaction({
      messageId: 'm1',
      offer: 3,
      spend: { faceIndices: [0, 2] },
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(1, 'foundry-mcp-bridge.useReaction', {
      messageId: 'm1',
      offer: 0,
    });
  });

  it('rejects missing ids, bad offers and bad dice selections', async () => {
    const { tools, query } = makeTools();
    const bad: any[] = [
      {},
      { offer: 0 },
      { messageId: 'm1' },
      { messageId: '', offer: 0 },
      { messageId: 'm1', offer: -1 },
      { messageId: 'm1', offer: 1.5 },
      { messageId: 'm1', offer: '' },
      { messageId: 'm1', offer: 0, force: 'yes' },
      { messageId: 'm1', offer: 0, spend: { faceIndices: [] } },
      { messageId: 'm1', offer: 0, spend: { faceIndices: [1, 1] } },
      { messageId: 'm1', offer: 0, spend: { faceIndices: [-2] } },
    ];
    for (const args of bad) await expect(tools.handleUseReaction(args)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('wraps bridge errors', async () => {
    const { tools, query } = makeTools();
    query.mockRejectedValueOnce(new Error('Chat message not found: zzz'));
    await expect(tools.handleUseReaction({ messageId: 'zzz', offer: 0 })).rejects.toThrow(
      /Failed to use reaction: Chat message not found/
    );
  });
});

describe('rest', () => {
  it('needs an actor and a safe or field rest type', async () => {
    const { tools, query } = makeTools();
    await expect(tools.handleRest({ actor: 'Kai' })).rejects.toThrow(/restType/);
    await expect(tools.handleRest({ actor: 'Kai', restType: 'long' })).rejects.toThrow(/restType/);
    await expect(tools.handleRest({ restType: 'safe' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    await tools.handleRest({ actor: 'Kai', restType: 'safe' });
    await tools.handleRest({ actor: 'Kai', restType: 'field' });
    expect(query).toHaveBeenLastCalledWith('foundry-mcp-bridge.restActor', {
      actor: 'Kai',
      restType: 'field',
    });
  });
});
