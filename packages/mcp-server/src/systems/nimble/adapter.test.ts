/**
 * Nimble Adapter Tests
 *
 * Validates level parsing, index extraction, filters, stat extraction and
 * payload normalization against fixtures taken from the Nimble system's
 * bundled Nimble Monsters / Nimble Legendary Monsters compendiums.
 */

import { describe, it, expect } from 'vitest';
import { NimbleAdapter } from './adapter.js';
import { matchesNimbleFilters, describeNimbleFilters, NimbleFiltersSchema } from './filters.js';
import { extractNimbleSystemData } from './index-builder.js';
import { parseNimbleLevel, getMonsterRole } from './constants.js';
import type { NimbleCreatureIndex } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const feature = (name: string, subtype: string, system: Record<string, any> = {}) => ({
  id: `${name}-id`,
  name,
  type: 'monsterFeature',
  system: {
    subtype,
    description: '',
    activation: { effects: [] },
    parentItemId: '',
    lastStandHp: 0,
    ...system,
  },
});

/** Solo monster (Nimble Legendary Monsters: "Krogg, Goblin King"). */
const krogg: any = {
  name: 'Krogg, Goblin King',
  type: 'soloMonster',
  system: {
    attributes: {
      armor: 'medium',
      damageResistances: [],
      damageVulnerabilities: [],
      damageImmunities: [],
      hp: { max: 75, temp: 0, value: 75 },
      sizeCategory: 'medium',
      movement: { burrow: 0, climb: 0, fly: 0, swim: 0, walk: 6 },
    },
    description: '',
    details: { creatureType: 'Angry Bugbear', level: '2' },
    attackSequence: '',
    savingThrows: {
      strength: { bonus: 0, defaultRollMode: 1, mod: 0 },
      dexterity: { bonus: 0, defaultRollMode: 1, mod: 0 },
      intelligence: { bonus: 0, defaultRollMode: 0, mod: 0 },
      will: { bonus: 0, defaultRollMode: 0, mod: 0 },
    },
  },
  items: [
    feature('Attack Sequence', 'attackSequence', {
      description: "<p>After each hero's turn, choose one:</p>",
    }),
    feature('Manglemaul.', 'action', {
      description: '<p>Move 6. 2d6+3 damage, Grappled (escape DC 10). OR:</p>',
      parentItemId: 'Attack Sequence-id',
      activation: {
        effects: [
          {
            id: 'kroggMangleDmg1',
            type: 'damage',
            damageType: 'bludgeoning',
            formula: '2d6+3',
            on: {
              hit: [
                { id: 'kroggMangleGrab', type: 'condition', condition: 'grappled' },
                { id: 'kroggMangleOut1', type: 'damageOutcome', outcome: 'fullDamage' },
              ],
            },
          },
        ],
      },
    }),
    feature('Bloodied', 'bloodied'),
    feature('Last Stand', 'lastStand', { lastStandHp: 20 }),
  ],
};

/** Minion (Nimble Monsters: "Goblin Minion"). */
const goblinMinion: any = {
  name: 'Goblin Minion',
  type: 'minion',
  system: {
    attributes: {
      armor: 'none',
      hp: { max: 1, temp: 0, value: 1 },
      sizeCategory: 'small',
      movement: { burrow: 0, climb: 0, fly: 0, swim: 0, walk: 6 },
    },
    details: { creatureType: 'Goblins', level: '1/4' },
    savingThrows: {},
  },
  items: [feature('Haha, Missed Me!', 'feature'), feature('Stab.', 'action')],
};

const toIndex = (actor: any): NimbleCreatureIndex => ({
  id: actor.name,
  name: actor.name,
  type: actor.type,
  packName: 'nimble.nimble-monsters',
  packLabel: 'Nimble Monsters',
  system: 'nimble',
  systemData: extractNimbleSystemData(actor),
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('parseNimbleLevel', () => {
  it('parses whole and fractional level strings', () => {
    expect(parseNimbleLevel('3')).toBe(3);
    expect(parseNimbleLevel('1/4')).toBe(0.25);
    expect(parseNimbleLevel('1/3')).toBeCloseTo(0.333, 3);
    expect(parseNimbleLevel(5)).toBe(5);
  });

  it('rejects unparseable levels', () => {
    expect(parseNimbleLevel('')).toBeUndefined();
    expect(parseNimbleLevel('boss')).toBeUndefined();
    expect(parseNimbleLevel('1/0')).toBeUndefined();
  });
});

describe('getMonsterRole', () => {
  it('derives role from actor type and flunky flag', () => {
    expect(getMonsterRole('minion')).toBe('minion');
    expect(getMonsterRole('soloMonster')).toBe('solo');
    expect(getMonsterRole('npc', false)).toBe('standard');
    expect(getMonsterRole('npc', true)).toBe('flunky');
    expect(getMonsterRole('character')).toBeUndefined();
  });
});

describe('extractNimbleSystemData', () => {
  it('indexes a solo monster', () => {
    const data = extractNimbleSystemData(krogg);
    expect(data).toMatchObject({
      level: 2,
      levelLabel: '2',
      role: 'solo',
      creatureType: 'Angry Bugbear',
      size: 'medium',
      armor: 'medium',
      hitPoints: 75,
      hasBloodied: true,
      hasLastStand: true,
      featureCount: 4,
      movement: { walk: 6 },
      saveRollModes: { strength: 1, dexterity: 1 },
    });
  });

  it('indexes a fractional-level minion', () => {
    const data = extractNimbleSystemData(goblinMinion);
    expect(data.level).toBe(0.25);
    expect(data.levelLabel).toBe('1/4');
    expect(data.role).toBe('minion');
    expect(data.hasBloodied).toBe(false);
  });
});

describe('Nimble filters', () => {
  const kroggIndex = toIndex(krogg);
  const minionIndex = toIndex(goblinMinion);
  const parse = (f: any) => NimbleFiltersSchema.parse(f);

  it('filters by level, including fraction strings and ranges', () => {
    expect(matchesNimbleFilters(minionIndex, parse({ level: '1/4' }))).toBe(true);
    expect(matchesNimbleFilters(kroggIndex, parse({ level: { min: 1, max: 3 } }))).toBe(true);
    expect(matchesNimbleFilters(minionIndex, parse({ level: { min: 1 } }))).toBe(false);
  });

  it('filters by role, creature type substring, armor and features', () => {
    expect(matchesNimbleFilters(kroggIndex, parse({ role: 'solo' }))).toBe(true);
    expect(matchesNimbleFilters(minionIndex, parse({ role: 'solo' }))).toBe(false);
    expect(matchesNimbleFilters(minionIndex, parse({ creatureType: 'goblin' }))).toBe(true);
    expect(matchesNimbleFilters(kroggIndex, parse({ armor: 'heavy' }))).toBe(false);
    expect(matchesNimbleFilters(kroggIndex, parse({ hasLastStand: true }))).toBe(true);
    expect(matchesNimbleFilters(minionIndex, parse({ hasLastStand: true }))).toBe(false);
  });

  it('describes filters', () => {
    expect(describeNimbleFilters(parse({ level: { min: 1, max: 3 }, role: 'solo' }))).toBe(
      'Level 1-3, solo'
    );
    expect(describeNimbleFilters(parse({}))).toBe('no filters');
  });
});

describe('NimbleAdapter', () => {
  const adapter = new NimbleAdapter();

  it('handles the nimble system id', () => {
    expect(adapter.canHandle('nimble')).toBe(true);
    expect(adapter.canHandle('dnd5e')).toBe(false);
    expect(adapter.getPowerLevel(toIndex(goblinMinion))).toBe(0.25);
  });

  it('extracts monster stats with feature summaries', () => {
    const stats = adapter.extractCharacterStats(krogg);
    expect(stats.level).toBe('2');
    expect(stats.role).toBe('solo');
    expect(stats.hitPoints).toEqual({ current: 75, max: 75, temp: 0 });
    expect(stats.saves.strength).toEqual({ mod: 0, rollMode: 1, rollModeLabel: 'advantage' });
    const mangle = stats.features.find((f: any) => f.name === 'Manglemaul.');
    expect(mangle.effects).toEqual(['2d6+3 bludgeoning', 'grappled']);
    expect(mangle.parentItemId).toBe('Attack Sequence-id');
    const lastStand = stats.features.find((f: any) => f.subtype === 'lastStand');
    expect(lastStand.lastStandHp).toBe(20);
  });

  it('extracts basic info', () => {
    expect(adapter.extractBasicInfo(goblinMinion)).toMatchObject({
      actorType: 'minion',
      level: '1/4',
      role: 'minion',
      creatureType: 'Goblins',
      size: 'small',
      armor: 'none',
    });
  });

  it('normalizes shorthand payloads', () => {
    expect(
      adapter.normalizePayload({
        level: 3,
        creatureType: 'Kobolds',
        hp: 30,
        armor: 'Heavy',
        size: 'Large',
        speed: 8,
        movement: { fly: 6 },
        saves: { str: 1, wil: -1 },
      })
    ).toEqual({
      details: { level: '3', creatureType: 'Kobolds' },
      attributes: {
        hp: { max: 30, value: 30, temp: 0 },
        armor: 'heavy',
        sizeCategory: 'large',
        movement: { walk: 8, fly: 6 },
      },
      savingThrows: {
        strength: { defaultRollMode: 1 },
        will: { defaultRollMode: -1 },
      },
    });
  });

  it('moves top-level damage traits under attributes', () => {
    expect(
      adapter.normalizePayload({
        damageImmunities: ['fire'],
        resistances: ['cold'],
        attributes: { armor: 'none' },
      })
    ).toEqual({
      attributes: { armor: 'none', damageImmunities: ['fire'], damageResistances: ['cold'] },
    });
  });

  it('leaves full payloads unchanged', () => {
    const full = {
      details: { level: '1/2', creatureType: 'Undead' },
      attributes: { hp: { max: 12, value: 5 }, armor: 'none' },
    };
    expect(adapter.normalizePayload(full)).toEqual(full);
  });
});
