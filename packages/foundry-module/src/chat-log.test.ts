import { describe, expect, it } from 'vitest';
import {
  htmlToText,
  parseChatMessage,
  selectChatMessages,
  summarizeRoll,
  type ChatMessageSource,
} from './chat-log.js';

// Fixtures modelled on Nimble 0.9.0 activation cards: rolls are stored as
// JSON strings on the message and as roll.toJSON() objects on effect nodes.
const die = (faces: number, results: Array<[number, boolean?, boolean?]>) => ({
  class: 'Die',
  number: results.length,
  faces,
  modifiers: [],
  evaluated: true,
  results: results.map(([result, active = true, exploded]) => ({
    result,
    active,
    ...(exploded ? { exploded: true } : {}),
  })),
});

const critDamageRoll = {
  class: 'DamageRoll',
  formula: '1d8x+2',
  total: 13,
  evaluated: true,
  isCritical: true,
  isMiss: false,
  terms: [
    die(8, [[8, true, true], [3]]),
    { class: 'OperatorTerm', operator: '+' },
    { class: 'NumericTerm', number: 2 },
  ],
};

const missDamageRoll = {
  class: 'DamageRoll',
  formula: '1d6+1',
  total: 2,
  evaluated: true,
  isCritical: false,
  isMiss: true,
  terms: [
    die(6, [[1]]),
    { class: 'OperatorTerm', operator: '+' },
    { class: 'NumericTerm', number: 1 },
  ],
};

const healingRoll = {
  class: 'Roll',
  formula: '2d6+3',
  total: 10,
  evaluated: true,
  terms: [
    die(6, [[4], [3]]),
    { class: 'OperatorTerm', operator: '+' },
    { class: 'NumericTerm', number: 3 },
  ],
};

const attackCard: ChatMessageSource = {
  _id: 'msgAttack0000001',
  timestamp: 1000,
  type: 'feature',
  author: 'gm00000000000001',
  speaker: { actor: 'goblinActor00001', token: 'goblinToken00001', alias: 'Goblin Boss' },
  flavor: 'Goblin Boss: Stab.',
  content: '',
  whisper: [],
  rolls: [JSON.stringify(critDamageRoll)],
  flags: {
    nimble: {
      itemId: 'stabItem00000001',
      itemUuid: 'Actor.goblinActor00001.Item.stabItem00000001',
      actorId: 'goblinActor00001',
    },
  },
  system: {
    actorName: 'Goblin Boss',
    actorType: 'npc',
    isCritical: true,
    isMiss: false,
    rollMode: 1,
    targets: ['Scene.s1.Token.heroToken000001'],
    activation: {
      effects: [
        {
          id: 'dmgNode000000001',
          type: 'damage',
          damageType: 'piercing',
          formula: '1d8+2',
          parentContext: null,
          parentNode: null,
          roll: critDamageRoll,
          on: {
            hit: [
              {
                id: 'outcome000000001',
                type: 'damageOutcome',
                outcome: 'fullDamage',
                parentContext: 'hit',
                parentNode: 'dmgNode000000001',
              },
              {
                id: 'cond000000000001',
                type: 'condition',
                condition: 'dazed',
                parentContext: 'hit',
                parentNode: 'dmgNode000000001',
              },
            ],
          },
        },
      ],
    },
  },
};

const healingCard: ChatMessageSource = {
  _id: 'msgHeal000000001',
  timestamp: 2000,
  type: 'spell',
  speaker: { actor: 'clericActor00001', alias: 'Brother Ash' },
  flavor: 'Brother Ash: Searing Light',
  content: '<p>Radiant light <strong>mends</strong> an ally.</p>',
  whisper: ['gm00000000000001'],
  blind: false,
  rolls: [JSON.stringify(healingRoll)],
  flags: {
    nimble: {
      itemId: 'searingLight0001',
      itemUuid: 'Actor.clericActor00001.Item.searingLight0001',
    },
  },
  system: {
    isCritical: false,
    isMiss: false,
    rollMode: 0,
    targets: ['Scene.s1.Token.fighterToken0001'],
    activation: {
      effects: [
        {
          id: 'healNode00000001',
          type: 'healing',
          healingType: 'healing',
          formula: '2d6+3',
          parentContext: null,
          parentNode: null,
          roll: healingRoll,
        },
      ],
    },
    appliedHealing: {
      healNode00000001: {
        effectId: 'healNode00000001',
        healingType: 'healing',
        amount: 10,
        appliedAt: 2100,
        targets: [
          {
            uuid: 'Scene.s1.Token.fighterToken0001',
            tokenName: 'Fighter',
            previousHp: 5,
            previousTempHp: 0,
            newHp: 15,
            newTempHp: 0,
          },
        ],
      },
    },
  },
};

const missCard: ChatMessageSource = {
  _id: 'msgMiss000000001',
  timestamp: 3000,
  speaker: { actor: 'goblinActor00001', alias: 'Goblin Boss' },
  flavor: 'Goblin Boss: Stab.',
  rolls: [JSON.stringify(missDamageRoll)],
  flags: { nimble: { itemUuid: 'Actor.goblinActor00001.Item.stabItem00000001' } },
  system: {
    isCritical: false,
    isMiss: true,
    targets: ['Scene.s1.Token.heroToken000001'],
    activation: {
      effects: [
        {
          id: 'dmgNode000000002',
          type: 'damage',
          damageType: 'piercing',
          parentContext: null,
          parentNode: null,
          roll: missDamageRoll,
          on: {
            hit: [{ id: 'o2', type: 'damageOutcome', outcome: 'fullDamage', parentContext: 'hit' }],
          },
        },
      ],
    },
  },
};

const resolvers = {
  actorName: (id: string) =>
    ({ goblinActor00001: 'Goblin Boss', clericActor00001: 'Brother Ash' })[id],
  tokenName: (ref: string) =>
    ref.endsWith('heroToken000001') ? 'Hero' : ref.endsWith('fighterToken0001') ? 'Fighter' : null,
  itemName: (uuid: string) => (uuid.endsWith('stabItem00000001') ? 'Stab.' : 'Searing Light'),
  userName: (id: string) => (id === 'gm00000000000001' ? 'Gamemaster' : null),
};

describe('summarizeRoll', () => {
  it('reads formula, total, every die and Nimble crit/miss flags', () => {
    expect(summarizeRoll(JSON.stringify(critDamageRoll))).toEqual({
      formula: '1d8x+2',
      total: 13,
      dice: [
        {
          faces: 8,
          results: [
            { result: 8, active: true, exploded: true },
            { result: 3, active: true },
          ],
        },
      ],
      isCritical: true,
      isMiss: false,
    });
  });

  it('marks discarded dice inactive and tolerates bad JSON', () => {
    const roll = { formula: '2d20kh', total: 17, terms: [die(20, [[17], [4, false]])] };
    expect(summarizeRoll(roll)!.dice[0].results[1].active).toBe(false);
    expect(summarizeRoll('{not json')).toBeNull();
  });
});

describe('parseChatMessage', () => {
  it('parses an attack that crits, with damage and an on-hit condition', () => {
    const parsed = parseChatMessage(attackCard, { resolvers });
    expect(parsed.speaker).toEqual({
      alias: 'Goblin Boss',
      actorId: 'goblinActor00001',
      actorName: 'Goblin Boss',
      tokenId: 'goblinToken00001',
      tokenName: null,
    });
    expect(parsed.item).toEqual({
      uuid: 'Actor.goblinActor00001.Item.stabItem00000001',
      id: 'stabItem00000001',
      name: 'Stab.',
    });
    expect(parsed.rolls?.[0].total).toBe(13);
    expect(parsed.nimble).toMatchObject({
      isCritical: true,
      isMiss: false,
      advantage: 1,
      targets: [{ uuid: 'Scene.s1.Token.heroToken000001', name: 'Hero' }],
    });
    const damage = parsed.nimble!.effects.find(e => e.type === 'damage')!;
    expect(damage).toMatchObject({
      damageType: 'piercing',
      outcome: 'fullDamage',
      amount: 13,
      applies: true,
    });
    const condition = parsed.nimble!.effects.find(e => e.type === 'condition')!;
    expect(condition).toMatchObject({ condition: 'dazed', context: 'hit', applies: true });
  });

  it('parses a healing card with its applied-healing record', () => {
    const parsed = parseChatMessage(healingCard, { resolvers });
    expect(parsed.content).toBe('Radiant light mends an ally.');
    expect(parsed.whispered).toBe(true);
    expect(parsed.whisperTo).toEqual(['Gamemaster']);
    expect(parsed.item?.name).toBe('Searing Light');
    expect(parsed.nimble!.effects).toEqual([
      expect.objectContaining({
        type: 'healing',
        healingType: 'healing',
        amount: 10,
        applies: true,
      }),
    ]);
    expect(parsed.nimble!.healingApplied).toEqual([
      expect.objectContaining({
        effectId: 'healNode00000001',
        amount: 10,
        targets: [expect.objectContaining({ tokenName: 'Fighter', previousHp: 5, newHp: 15 })],
      }),
    ]);
  });

  it('reports a miss as no damage and skips hit-only branches', () => {
    const parsed = parseChatMessage(missCard, { resolvers });
    expect(parsed.nimble!.isMiss).toBe(true);
    const damage = parsed.nimble!.effects.find(e => e.type === 'damage')!;
    expect(damage).toMatchObject({ outcome: 'noDamage', amount: 0 });
    expect(damage.roll?.isMiss).toBe(true);
    expect(parsed.nimble!.effects.find(e => e.type === 'damageOutcome')!.applies).toBe(false);
  });

  it('uses a miss-branch damageOutcome (half damage) when present', () => {
    const halfOnMiss = structuredClone(missCard);
    halfOnMiss.system!.activation.effects[0].on.miss = [
      { id: 'o3', type: 'damageOutcome', outcome: 'halfDamage', parentContext: 'miss' },
    ];
    const damage = parseChatMessage(halfOnMiss).nimble!.effects.find(e => e.type === 'damage')!;
    expect(damage).toMatchObject({ outcome: 'halfDamage', amount: 1 });
  });

  it('omits roll detail when includeRolls is false but keeps amounts', () => {
    const parsed = parseChatMessage(attackCard, { includeRolls: false });
    expect(parsed.rolls).toBeUndefined();
    const damage = parsed.nimble!.effects.find(e => e.type === 'damage')!;
    expect(damage.roll).toBeUndefined();
    expect(damage.amount).toBe(13);
  });

  it('handles a plain non-Nimble message', () => {
    const parsed = parseChatMessage({
      _id: 'plain',
      content: 'Hello<br>world &amp; all',
      speaker: { alias: 'GM' },
      blind: true,
    });
    expect(parsed.content).toBe('Hello\nworld & all');
    expect(parsed.blind).toBe(true);
    expect(parsed.nimble).toBeUndefined();
    expect(parsed.item).toBeNull();
  });
});

describe('selectChatMessages', () => {
  const all = [attackCard, healingCard, missCard].map(m => ({ ...m, id: m._id }));
  const bySpeaker = (m: ChatMessageSource, s: string) =>
    (m.speaker?.alias ?? '').toLowerCase() === s.toLowerCase();

  it('returns the last N in order', () => {
    expect(selectChatMessages(all, { limit: 2 }, bySpeaker).map(m => m.id)).toEqual([
      'msgHeal000000001',
      'msgMiss000000001',
    ]);
  });

  it('filters by sinceMessageId, sinceTimestamp and speaker', () => {
    expect(
      selectChatMessages(all, { sinceMessageId: 'msgAttack0000001' }, bySpeaker).map(m => m.id)
    ).toEqual(['msgHeal000000001', 'msgMiss000000001']);
    expect(selectChatMessages(all, { sinceTimestamp: 2000 }, bySpeaker).map(m => m.id)).toEqual([
      'msgMiss000000001',
    ]);
    expect(selectChatMessages(all, { speaker: 'goblin boss' }, bySpeaker)).toHaveLength(2);
  });

  it('errors on an unknown sinceMessageId', () => {
    expect(() => selectChatMessages(all, { sinceMessageId: 'nope' }, bySpeaker)).toThrow(
      /not found/
    );
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes common entities', () => {
    expect(htmlToText('<h3>Stab</h3><p>1d6&nbsp;+ 2 &lt;piercing&gt;</p>')).toBe(
      'Stab\n1d6 + 2 <piercing>'
    );
  });
});
