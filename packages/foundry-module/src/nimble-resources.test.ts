import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectActorResources,
  collectChargePools,
  collectDicePools,
  diffRestSnapshots,
} from './nimble-resources.js';

const list = <T>(items: T[]) => Object.assign(items, { contents: items });

// A Shepherd with the user's broken Accord Bond pair: the pool rule failed
// validation (initial "full"), so no pool exists and the consumer cannot resolve it.
const featureRules = [
  {
    id: 'accordbondpool01',
    type: 'chargePool',
    identifier: 'accord-bond',
    label: 'Accord Bond',
    scope: 'actor',
    initial: 'full',
  },
  {
    id: 'accordbondspend1',
    type: 'chargeConsumer',
    label: 'Accord Bond use',
    poolIdentifier: 'accord-bond',
    poolScope: 'actor',
    cost: '1',
  },
  { id: 'offrule000000001', type: 'note', label: 'Switched off', disabled: true },
];

const feature = {
  id: 'featAccord00001',
  name: 'Accord Bond',
  flags: {},
  system: { rules: featureRules },
  rules: Object.assign(new Map<string, any>(), {
    failures: new Map([['accordbondpool01', { text: 'initial: "full" is not a valid choice' }]]),
    failureFor(id: string) {
      return this.failures.get(id)?.text;
    },
  }),
};
feature.rules.set('accordbondpool01', {
  id: 'accordbondpool01',
  disabled: true,
  appliesTo: () => false,
});
feature.rules.set('accordbondspend1', {
  id: 'accordbondspend1',
  disabled: false,
  appliesTo: () => true,
});
feature.rules.set('offrule000000001', {
  id: 'offrule000000001',
  disabled: true,
  appliesTo: () => false,
});

const fury = {
  id: 'itemFury000001',
  name: 'Fury',
  flags: {
    nimble: {
      dicePools: {
        fury: {
          identifier: 'fury',
          max: 4,
          dieSize: 'd6',
          faces: [3, 6],
          consumption: 'manual',
          refills: [{ trigger: 'safeRest', mode: 'refresh', value: '0' }],
        },
      },
      chargePools: {
        charges: {
          identifier: 'charges',
          max: 3,
          current: 1,
          dieSize: null,
          recoveries: [{ trigger: 'safeRest', mode: 'refresh', value: '0' }],
        },
      },
    },
  },
  system: {
    rules: [
      { id: 'furyPool00000001', type: 'dicePool', identifier: 'fury', scope: 'item' },
      { id: 'furySpend0000001', type: 'diceConsumer', poolIdentifier: 'fury', poolScope: 'item' },
    ],
  },
  rules: Object.assign(
    new Map<string, any>([
      ['furyPool00000001', { disabled: false, appliesTo: () => true }],
      ['furySpend0000001', { disabled: false, appliesTo: () => true }],
    ]),
    { failures: new Map(), failureFor: () => undefined }
  ),
};

const actor = {
  id: 'shepherd0000001',
  name: 'Brother Aldous',
  type: 'character',
  flags: {
    nimble: {
      chargePools: {
        'actor:grace': {
          identifier: 'grace',
          max: 2,
          current: 2,
          sourceItemId: 'x',
          sourceItemName: 'Grace',
          label: 'Grace',
          hidden: true,
        },
        'ignored-item-key': { identifier: 'nope', max: 9, current: 9 },
      },
    },
  },
  items: list([feature, fury]),
  effects: list([
    {
      id: 'eff1',
      name: 'Rage',
      disabled: false,
      flags: { nimble: { toggleEffectRuleId: 'rageRule', toggleEffectItemId: 'itemRage' } },
    },
    {
      id: 'eff2',
      name: 'Stance',
      disabled: true,
      flags: { nimble: { toggleEffectRuleId: 'stanceRule' } },
    },
    { id: 'eff3', name: 'Burning', disabled: false, flags: {} },
  ]),
};

afterEach(() => vi.unstubAllGlobals());

describe('pool collection', () => {
  it('reads actor- and item-scoped charge pools from flags', () => {
    const pools = collectChargePools(actor);
    expect(
      pools.map(p => [p.poolId, p.scope, p.owningItem.name, p.current, p.max, p.hidden])
    ).toEqual([
      ['actor:grace', 'actor', 'Grace', 2, 2, true],
      ['charges', 'item', 'Fury', 1, 3, false],
    ]);
    expect(pools[1].recoveries).toEqual([{ trigger: 'safeRest', mode: 'refresh', value: '0' }]);
  });

  it('reads dice pools with their faces', () => {
    expect(collectDicePools(actor)).toEqual([
      expect.objectContaining({
        poolId: 'fury',
        current: 2,
        max: 4,
        dieSize: 'd6',
        faces: [3, 6],
        consumption: 'manual',
      }),
    ]);
  });
});

describe('collectActorResources', () => {
  vi.stubGlobal('game', {
    settings: { get: (_s: string, key: string) => key !== 'automation.resourceRecovery' },
  });
  const result = collectActorResources(actor);

  it('reports rules that failed validation with the reason Nimble recorded', () => {
    expect(result.rules.problems).toEqual([
      expect.objectContaining({
        ruleId: 'accordbondpool01',
        type: 'chargePool',
        status: 'invalid',
        reason: 'initial: "full" is not a valid choice',
        itemName: 'Accord Bond',
      }),
      expect.objectContaining({ ruleId: 'offrule000000001', status: 'disabled' }),
    ]);
  });

  it('flags a consumer whose pool does not exist', () => {
    const consumer = result.rules.resourceRules.find((r: any) => r.ruleId === 'accordbondspend1');
    expect(consumer).toMatchObject({
      poolId: 'actor:accord-bond',
      poolExists: false,
      running: true,
    });
    expect(consumer.problem).toContain('poolMissing');
    const pool = result.rules.resourceRules.find((r: any) => r.ruleId === 'accordbondpool01');
    expect(pool).toMatchObject({ running: false, poolExists: false });
  });

  it('matches working consumers to their pools', () => {
    const spend = result.rules.resourceRules.find((r: any) => r.ruleId === 'furySpend0000001');
    expect(spend).toMatchObject({ poolId: 'fury', poolExists: true });
    expect(spend.problem).toBeUndefined();
  });

  it('lists active toggles only and counts inactive ones', () => {
    expect(result.activeToggles).toEqual([
      { effectId: 'eff1', name: 'Rage', ruleId: 'rageRule', itemId: 'itemRage' },
    ]);
    expect(result.inactiveToggleCount).toBe(1);
  });

  it('includes the automation settings', () => {
    expect(result.automation['automation.resourceRecovery']).toBe(false);
    expect(result.automation['automation.resourceSpending']).toBe(true);
  });
});

describe('diffRestSnapshots', () => {
  const base = {
    hp: 5,
    tempHp: 2,
    wounds: 1,
    mana: 0,
    hitDice: { '8': { current: 1 } },
    chargePools: { charges: 1, 'actor:grace': 2 },
    dicePools: { fury: [3] },
  };

  it('lists only what changed', () => {
    const after = {
      ...base,
      hp: 12,
      tempHp: 0,
      wounds: 0,
      hitDice: { '8': { current: 2 } },
      chargePools: { charges: 3, 'actor:grace': 2 },
      dicePools: { fury: [3, 5, 6] },
    };
    expect(diffRestSnapshots(base, after)).toEqual({
      hp: { before: 5, after: 12 },
      tempHp: { before: 2, after: 0 },
      wounds: { before: 1, after: 0 },
      hitDice: { '8': { before: { current: 1 }, after: { current: 2 } } },
      chargePools: { charges: { before: 1, after: 3 } },
      dicePools: { fury: { before: [3], after: [3, 5, 6] } },
    });
  });

  it('is empty when nothing changed', () => {
    expect(diffRestSnapshots(base, structuredClone(base))).toEqual({});
  });
});
