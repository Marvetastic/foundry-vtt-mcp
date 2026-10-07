import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTemplate,
  describeField,
  describeNimbleRules,
  validateRuleSource,
} from './nimble-rules.js';

// Minimal stand-ins for Foundry data fields: classes named like the real ones,
// carrying the properties describeField reads.
class StringField {
  constructor(public props: Record<string, any>) {
    Object.assign(this, props);
  }
}
class NumberField extends StringField {}
class ArrayField extends StringField {}
class SchemaField extends StringField {}

const chargePoolFields = {
  scope: new StringField({
    required: true,
    nullable: false,
    initial: 'item',
    choices: ['item', 'actor'],
  }),
  max: new StringField({
    required: true,
    nullable: false,
    initial: '1',
    options: { widget: 'formula' },
  }),
  initial: new StringField({
    required: true,
    nullable: false,
    initial: 'max',
    choices: ['max', 'zero'],
  }),
  recoveries: new ArrayField({
    required: true,
    nullable: false,
    initial: [],
    element: new SchemaField({
      fields: {
        trigger: new StringField({
          required: true,
          nullable: false,
          initial: 'safeRest',
          choices: ['safeRest', 'fieldRest'],
        }),
        mode: new StringField({
          required: true,
          nullable: false,
          initial: 'add',
          choices: () => ['add', 'set', 'refresh'],
        }),
      },
    }),
  }),
  range: new NumberField({
    required: true,
    nullable: false,
    initial: 2,
    min: 1,
    integer: true,
    options: { showWhen: () => true },
  }),
  id: new StringField({ required: true, nullable: false, initial: () => 'random' }),
};

afterEach(() => vi.unstubAllGlobals());

describe('describeField', () => {
  it('reports type, requirement, default and allowed values', () => {
    expect(describeField('initial', chargePoolFields.initial)).toMatchObject({
      name: 'initial',
      kind: 'StringField',
      required: true,
      nullable: false,
      default: 'max',
      choices: ['max', 'zero'],
    });
  });

  it('resolves function choices, nested schema fields and array elements', () => {
    const recoveries = describeField('recoveries', chargePoolFields.recoveries);
    expect(recoveries.kind).toBe('ArrayField');
    const element = recoveries.element!;
    expect(element.fields!.map(f => f.name)).toEqual(['trigger', 'mode']);
    expect(element.fields![1].choices).toEqual(['add', 'set', 'refresh']);
  });

  it('reads numeric bounds, widgets and conditional visibility; hides generated ids', () => {
    expect(describeField('range', chargePoolFields.range)).toMatchObject({
      min: 1,
      integer: true,
      conditional: true,
    });
    expect(describeField('max', chargePoolFields.max).widget).toBe('formula');
    expect(describeField('id', chargePoolFields.id).default).toBe('<generated>');
  });
});

describe('buildTemplate', () => {
  it('builds a default-valued rule without the generated id', () => {
    const fields = Object.entries(chargePoolFields).map(([n, f]) => describeField(n, f));
    expect(buildTemplate(fields)).toMatchObject({
      scope: 'item',
      max: '1',
      initial: 'max',
      recoveries: [],
    });
    expect(buildTemplate(fields)).not.toHaveProperty('id');
  });
});

describe('validateRuleSource', () => {
  it('reports unknown rule types', () => {
    vi.stubGlobal('CONFIG', { NIMBLE: { ruleDataModels: {} } });
    expect(validateRuleSource('nope', {})).toEqual({
      valid: false,
      problems: ['Unknown rule type "nope"'],
    });
  });

  it('returns the failure text Nimble records for an invalid rule', () => {
    class FakeRule {
      invalid = true;
      validationFailures = {
        initial: { unresolved: true, toString: () => 'initial:   "full" is not a valid choice' },
        ok: { unresolved: false, toString: () => 'ignored' },
      };
    }
    vi.stubGlobal('CONFIG', { NIMBLE: { ruleDataModels: { chargePool: FakeRule } } });
    expect(validateRuleSource('chargePool', { initial: 'full' })).toEqual({
      valid: false,
      problems: ['initial: "full" is not a valid choice'],
    });
  });

  it('accepts a valid rule', () => {
    class GoodRule {
      invalid = false;
    }
    vi.stubGlobal('CONFIG', { NIMBLE: { ruleDataModels: { chargePool: GoodRule } } });
    expect(validateRuleSource('chargePool', {})).toEqual({ valid: true, problems: [] });
  });
});

describe('describeNimbleRules', () => {
  it('requires Nimble', () => {
    vi.stubGlobal('game', { system: { id: 'dnd5e' } });
    expect(() => describeNimbleRules({})).toThrow(/requires the Nimble system/);
  });

  it('describes one type, with notes, and rejects unknown types', () => {
    class FakeChargePool {
      static group = 'resource';
      static description = 'pool';
      static schema = { fields: chargePoolFields };
    }
    vi.stubGlobal('game', { system: { id: 'nimble', version: '0.9.0' } });
    vi.stubGlobal('CONFIG', {
      NIMBLE: {
        ruleDataModels: { chargePool: FakeChargePool },
        ruleTypes: { chargePool: 'Charge Pool' },
      },
    });
    const one = describeNimbleRules({ type: 'chargePool' });
    expect(one.rule.group).toBe('resource');
    expect(one.rule.template.type).toBe('chargePool');
    expect(one.rule.notes.join(' ')).toContain('"max" | "zero" (NOT "full")');
    expect(() => describeNimbleRules({ type: 'zap' })).toThrow(/Known types: chargePool/);
    expect(describeNimbleRules({}).ruleTypes).toHaveLength(1);
  });
});
