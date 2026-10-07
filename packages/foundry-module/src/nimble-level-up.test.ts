import { describe, expect, it } from 'vitest';
import {
  analyzeNimbleLevelUp,
  defaultSlugify,
  type LevelUpAnalysisInput,
  type LevelUpFeatureInput,
} from './nimble-level-up.js';

// Fixtures modelled on a custom Shepherd subclass authored as world items.
const effect = (id: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'damage',
  formula: '1d6',
  ...extra,
});

const goodFeature: LevelUpFeatureInput = {
  uuid: 'Item.goodFeature00001',
  name: 'Crook of Embers',
  source: 'world',
  system: {
    class: 'shepherd',
    group: 'flock-of-ash',
    subclass: true,
    gainedAtLevel: 3,
    gainedAtLevels: [3],
    activation: {
      effects: [
        effect('aaaaaaaaaaaaaaaa', {
          on: { hit: [{ id: 'bbbbbbbbbbbbbbbb', type: 'damageOutcome' }] },
        }),
      ],
    },
  },
};

const brokenFeature: LevelUpFeatureInput = {
  uuid: 'Item.brokenFeature0001',
  name: 'Smouldering Herd',
  source: 'world',
  system: {
    class: 'shepherd',
    // Uses the stored identifier, not the slugified subclass name.
    group: 'ash',
    subclass: true,
    gainedAtLevel: 5,
    gainedAtLevels: [7],
    activation: {
      effects: [
        effect('short'),
        effect('cccccccccccccccc', {
          on: { hit: [{ id: 'cccccccccccccccc', type: 'condition' }] },
        }),
      ],
    },
  },
};

function baseInput(overrides: Partial<LevelUpAnalysisInput> = {}): LevelUpAnalysisInput {
  return {
    classIdentifier: 'shepherd',
    level: 3,
    classes: [{ uuid: 'Item.shepherdClass0001', name: 'Shepherd', source: 'world' }],
    subclasses: [
      {
        uuid: 'Item.flockOfAsh000001',
        name: 'Flock of Ash',
        source: 'world',
        parentClass: 'shepherd',
        storedIdentifier: 'ash',
      },
      {
        uuid: 'Compendium.nimble.nimble-subclasses.Item.keeper0000000001',
        name: 'Keeper of the Fold',
        source: 'compendium',
        pack: 'nimble.nimble-subclasses',
        parentClass: 'shepherd',
        storedIdentifier: 'keeper-of-the-fold',
      },
      {
        uuid: 'Item.otherClassSub001',
        name: 'Path of Rage',
        source: 'world',
        parentClass: 'berserker',
        storedIdentifier: '',
      },
    ],
    features: [
      goodFeature,
      brokenFeature,
      {
        uuid: 'Item.classAuto0000001',
        name: 'Shepherd Training',
        source: 'world',
        system: { class: 'shepherd', group: '', gainedAtLevels: [1, 3] },
      },
      {
        uuid: 'Item.choiceA000000001',
        name: 'Herding Call',
        source: 'world',
        system: { class: 'shepherd', group: 'calls', gainedAtLevel: 3 },
      },
      {
        uuid: 'Item.choiceB000000001',
        name: 'Rallying Call',
        source: 'world',
        system: {
          class: 'shepherd',
          group: 'calls',
          gainedAtLevel: 3,
          selectionCountByLevel: { '3': 2 },
        },
      },
    ],
    ...overrides,
  };
}

const codes = (result: ReturnType<typeof analyzeNimbleLevelUp>) => result.warnings.map(w => w.code);

describe('analyzeNimbleLevelUp', () => {
  it('slugifies like Foundry strict mode', () => {
    expect(defaultSlugify('Flock of Ash')).toBe('flock-of-ash');
    expect(defaultSlugify("Keeper  of the Fold's")).toBe('keeper-of-the-folds');
    expect(defaultSlugify('Éclair')).toBe('eclair');
  });

  it('offers world and compendium subclasses of the class only, keyed by slugified name', () => {
    const result = analyzeNimbleLevelUp(baseInput());
    expect(result.subclassesOffered.map(s => [s.name, s.source, s.groupKey])).toEqual([
      ['Flock of Ash', 'world', 'flock-of-ash'],
      ['Keeper of the Fold', 'compendium', 'keeper-of-the-fold'],
    ]);
    expect(result.classFound).toHaveLength(1);
  });

  it('splits class features into auto-grant and selection groups', () => {
    const result = analyzeNimbleLevelUp(baseInput());
    expect(result.classFeatures.autoGrant.map(f => f.name)).toEqual(['Shepherd Training']);
    expect(result.classFeatures.selectionGroups).toEqual([
      expect.objectContaining({ group: 'calls', selectionCount: 2 }),
    ]);
  });

  it('grants only features whose group equals the slugified subclass name', () => {
    const result = analyzeNimbleLevelUp(baseInput({ subclassIdentifier: 'flock-of-ash' }));
    expect(result.subclassFeatures).toEqual([
      {
        subclass: 'Flock of Ash',
        groupKey: 'flock-of-ash',
        features: [expect.objectContaining({ name: 'Crook of Embers' })],
      },
    ]);
  });

  it('flags the broken feature', () => {
    const result = analyzeNimbleLevelUp(baseInput());
    const broken = result.warnings.filter(w => w.uuid === brokenFeature.uuid).map(w => w.code);
    expect(broken).toEqual(
      expect.arrayContaining([
        'feature-group-no-subclass',
        'gained-at-level-mismatch',
        'effect-id-invalid',
        'effect-id-duplicate',
      ])
    );
    const groupWarning = result.warnings.find(w => w.code === 'feature-group-no-subclass')!;
    expect(groupWarning.message).toContain('flock-of-ash');
    expect(result.warnings.filter(w => w.uuid === goodFeature.uuid)).toEqual([]);
  });

  it('warns when a stored subclass identifier differs from the slugified name', () => {
    const result = analyzeNimbleLevelUp(baseInput());
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'subclass-identifier-mismatch', name: 'Flock of Ash' })
    );
  });

  it('reports empty stored identifiers and empty slugs', () => {
    const result = analyzeNimbleLevelUp(
      baseInput({
        subclasses: [
          {
            uuid: 'Item.a',
            name: 'Blank Id',
            source: 'world',
            parentClass: 'shepherd',
            storedIdentifier: '',
          },
          {
            uuid: 'Item.b',
            name: '!!!',
            source: 'world',
            parentClass: 'shepherd',
            storedIdentifier: 'x',
          },
        ],
      })
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(['subclass-stored-identifier-empty', 'subclass-empty-identifier'])
    );
  });

  it('flags duplicate subclass identifiers', () => {
    const input = baseInput();
    input.subclasses.push({
      uuid: 'Item.dupe',
      name: 'Flock of Ash',
      source: 'world',
      parentClass: 'shepherd',
      storedIdentifier: 'flock-of-ash',
    });
    expect(codes(analyzeNimbleLevelUp(input))).toContain('duplicate-subclass-identifier');
  });

  it('errors when the requested subclass is not offered', () => {
    const result = analyzeNimbleLevelUp(baseInput({ subclassIdentifier: 'nope' }));
    expect(codes(result)).toContain('subclass-not-offered');
    expect(result.subclassFeatures[0].features).toEqual([]);
  });

  it('warns when the class identifier matches no class item', () => {
    const result = analyzeNimbleLevelUp(baseInput({ classes: [] }));
    expect(codes(result)).toContain('class-not-found');
  });

  it('notes that subclass choice only happens at level 3', () => {
    const result = analyzeNimbleLevelUp(baseInput({ level: 5 }));
    expect(result.subclassChoiceOfferedAtThisLevel).toBe(false);
    expect(codes(result)).toContain('subclass-choice-level');
  });
});
