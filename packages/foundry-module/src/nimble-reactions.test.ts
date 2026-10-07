import { describe, expect, it } from 'vitest';
import { parseChatMessage, parseIncomingReactions, type ChatLogResolvers } from './chat-log.js';
import { selectOffer } from './nimble-reactions.js';

// An attack card (Nimble 0.9.0) on "Goblin Boss" targeting the Rogue, with the
// offers Nimble stamps from utils/incomingAttackModifiers.ts: a rule-sourced
// Interpose (Aura of Refuge style, range 6), a baseline Interpose, a force
// reroll on the Rogue and an attacker-side dice spend that was already used.
const names: Record<string, string> = {
  'Actor.shepherd0000001': 'Brother Aldous',
  'Actor.fighter00000001': 'Kai Veyl',
  'Actor.rogue000000001': 'Mira',
  'Actor.boss0000000001': 'Goblin Boss',
  'Scene.s1.Token.tokShepherd': 'Brother Aldous',
  'Scene.s1.Token.tokFighter': 'Kai Veyl',
  'Scene.s1.Token.tokRogue': 'Mira',
  'Item.aura0000000001': 'Aura of Refuge',
  'Item.fury0000000001': 'Fury',
};

const resolvers: ChatLogResolvers = {
  actorName: id => names[`Actor.${id}`] ?? null,
  tokenName: ref => names[ref] ?? null,
  uuidName: uuid => names[uuid] ?? null,
  userName: id => ({ u1: 'Yarden', u2: 'Dana' })[id] ?? null,
  actorOwners: uuid =>
    uuid === 'Actor.shepherd0000001' ? ['Dana'] : uuid === 'Actor.fighter00000001' ? [] : null,
  reactionRule: (itemUuid, ruleId) =>
    itemUuid === 'Item.aura0000000001' && ruleId === 'ruleRedirect0001'
      ? { modifier: 'redirectToSelf', range: 6, disabled: false }
      : null,
};

const incomingReactions = [
  {
    id: 'offerAura0000001',
    kind: 'redirectToSelf',
    source: 'rule',
    actorUuid: 'Actor.shepherd0000001',
    tokenUuid: 'Scene.s1.Token.tokShepherd',
    targetTokenUuid: 'Scene.s1.Token.tokRogue',
    label: 'Aura of Refuge',
    ruleId: 'ruleRedirect0001',
    itemUuid: 'Item.aura0000000001',
    used: false,
    usedBy: null,
  },
  {
    id: 'offerBase00000001',
    kind: 'redirectToSelf',
    source: 'baseline',
    actorUuid: 'Actor.fighter00000001',
    tokenUuid: 'Scene.s1.Token.tokFighter',
    targetTokenUuid: 'Scene.s1.Token.tokRogue',
    label: '',
    ruleId: '',
    itemUuid: '',
    used: false,
    usedBy: null,
  },
  {
    id: 'offerReroll00001',
    kind: 'forceReroll',
    source: 'rule',
    actorUuid: 'Actor.rogue000000001',
    tokenUuid: 'Scene.s1.Token.tokRogue',
    targetTokenUuid: 'Scene.s1.Token.tokRogue',
    label: 'Slippery',
    ruleId: 'ruleReroll00001',
    itemUuid: '',
    used: false,
    rerollTrigger: 'criticalHit',
    rerollWithDisadvantage: true,
  },
  {
    id: 'offerSpend000001',
    kind: 'spendPoolForDamage',
    source: 'rule',
    actorUuid: 'Actor.boss0000000001',
    label: 'Fury spend',
    ruleId: 'ruleSpend0000001',
    itemUuid: 'Item.fury0000000001',
    used: true,
    usedBy: 'u1',
    usedAmount: 4,
    usedPoolLabel: 'Fury Dice',
    usedFaces: [4],
    outcomeTrigger: 'hit',
  },
];

const attackCard = {
  _id: 'msgInterpose0001',
  timestamp: 5000,
  type: 'feature',
  speaker: { actor: 'boss0000000001', alias: 'Goblin Boss' },
  flags: { nimble: { itemId: 'stab', itemUuid: 'Item.stab00000000001' } },
  system: {
    activation: { effects: [] },
    isCritical: false,
    isMiss: false,
    rollMode: 0,
    targets: ['Scene.s1.Token.tokRogue'],
    incomingReactions,
  },
};

describe('parseIncomingReactions', () => {
  const offers = parseIncomingReactions(incomingReactions, resolvers);

  it('lists every offer with its index, id and button label', () => {
    expect(offers.map(o => [o.index, o.kind, o.source, o.label])).toEqual([
      [0, 'redirectToSelf', 'rule', 'Interpose: Aura of Refuge — Brother Aldous'],
      [1, 'redirectToSelf', 'baseline', 'Interpose (Heroic Reaction) — Kai Veyl'],
      [2, 'forceReroll', 'rule', 'Force Reroll: Slippery — Mira'],
      [3, 'spendPoolForDamage', 'rule', 'Add Damage: Fury'],
    ]);
  });

  it('says who can take each offer: the GM plus the reacting actor’s owners', () => {
    expect(offers[0].canBeTakenBy).toEqual(['GM', 'Dana']);
    expect(offers[1].canBeTakenBy).toEqual(['GM']);
  });

  it('explains the rule-sourced redirect with its live range and source item', () => {
    const aura = offers[0];
    expect(aura.sourceItem).toEqual({ uuid: 'Item.aura0000000001', name: 'Aura of Refuge' });
    expect(aura.protects).toEqual({ uuid: 'Scene.s1.Token.tokRogue', name: 'Mira' });
    expect(aura.rule).toEqual({ modifier: 'redirectToSelf', range: 6, disabled: false });
    expect(aura.why).toContain('within 6 spaces of Mira');
    expect(aura.why).toContain('"Aura of Refuge"');
  });

  it('explains the baseline Interpose as a 2-space heroic reaction', () => {
    expect(offers[1].why).toContain('within 2 spaces of Mira');
    expect(offers[1].why).toContain('heroic reaction');
    expect(offers[1].sourceItem).toBeNull();
  });

  it('reports reroll semantics and used spends', () => {
    expect(offers[2].rerollTrigger).toBe('criticalHit');
    expect(offers[2].rerollWithDisadvantage).toBe(true);
    expect(offers[3]).toMatchObject({
      used: true,
      usedBy: 'Yarden',
      usedNote: '+4 damage from Fury Dice (dice 4)',
      outcomeTrigger: 'hit',
    });
  });

  it('copes with missing or malformed data', () => {
    expect(parseIncomingReactions(undefined)).toEqual([]);
    expect(parseIncomingReactions([{}])[0]).toMatchObject({
      index: 0,
      kind: 'unknown',
      used: false,
    });
  });
});

describe('parseChatMessage with reaction offers', () => {
  it('puts the offers under nimble.reactions', () => {
    const parsed = parseChatMessage(attackCard, { resolvers });
    expect(parsed.nimble?.reactions).toHaveLength(4);
    expect(parsed.nimble?.reactions[0]?.id).toBe('offerAura0000001');
    expect(parsed.nimble?.targets).toEqual([{ uuid: 'Scene.s1.Token.tokRogue', name: 'Mira' }]);
  });

  it('gives an empty list for cards without offers', () => {
    const system: Record<string, unknown> = { ...attackCard.system };
    delete system.incomingReactions;
    const parsed = parseChatMessage({ ...attackCard, system }, { resolvers });
    expect(parsed.nimble?.reactions).toEqual([]);
  });
});

describe('selectOffer', () => {
  const offers = parseIncomingReactions(incomingReactions, resolvers);

  it('selects by index, id, exact label and unique label fragment', () => {
    expect(selectOffer(offers, 2).id).toBe('offerReroll00001');
    expect(selectOffer(offers, 'offerBase00000001').index).toBe(1);
    expect(selectOffer(offers, 'Interpose: Aura of Refuge — Brother Aldous').index).toBe(0);
    expect(selectOffer(offers, 'slippery').index).toBe(2);
  });

  it('refuses ambiguous labels and lists the indices', () => {
    expect(() => selectOffer(offers, 'interpose')).toThrow(/\[0\].*\[1\]/);
  });

  it('refuses unknown offers and out-of-range indices', () => {
    expect(() => selectOffer(offers, 'dance')).toThrow(/No offer matches/);
    expect(() => selectOffer(offers, 9)).toThrow(/index 9/);
  });
});
