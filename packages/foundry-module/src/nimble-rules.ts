/**
 * Nimble rule schema reflection (browser side, read-only).
 *
 * Reads the schema of every rule type from the live data models, so the answer
 * is always what the installed system validates — not a copy that can drift.
 * Nimble (v0.9.0) source, per the system source maps (nimble-*.js.map):
 *
 * - config/registerRulesConfig.ts  CONFIG.NIMBLE.ruleDataModels / ruleTypes:
 *   rule `type` → DataModel class (models/rules/*.ts); each class has a static
 *   `group` and `description` and defines its fields in `defineSchema()`.
 * - models/rules/base.ts  NimbleBaseRule: constructed with `strict: true`; a
 *   rule that fails validation is built anyway and force-disabled
 *   (`if (this.invalid) this.disabled = true`).
 * - managers/RulesManager.ts  item.rules: Map of live rules plus `failures`
 *   (why each rule is not running) — see nimble-resources.ts.
 * - utils/chargePoolRuleConfig.ts, utils/dicePool/dicePoolRuleConfig.ts: the
 *   enum values behind the `choices` of pool/recovery/refill fields.
 */

import { requireNimble } from './combat-tools.js';

/** Fields as Foundry's DataField exposes them; typed loosely like the rest of the bridge. */
type FieldLike = Record<string, any>;

export interface FieldDescription {
  name: string;
  /** Foundry field class: StringField, NumberField, BooleanField, ArrayField, SchemaField, ObjectField... */
  kind: string;
  required: boolean;
  nullable: boolean;
  /** Value used when the field is omitted (generated values are shown as "<generated>"). */
  default: unknown;
  choices?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** For ArrayField: the element's description. */
  element?: Omit<FieldDescription, 'name'>;
  /** For SchemaField: the nested fields. */
  fields?: FieldDescription[];
  label?: string;
  hint?: string;
  /** Rules-builder widget: formula, predicate, richText... "dynamic" when chosen at runtime. */
  widget?: string;
  /** True when the rules builder only shows the field for some values of a sibling field. */
  conditional?: boolean;
}

export interface RuleTypeDescription {
  type: string;
  group: string;
  description: string | null;
  label: string | null;
  fields: FieldDescription[];
  /** Every field set to its default: a starting point that already validates. */
  template: Record<string, unknown>;
  /** Required-by-schema fields whose default is blank and must be filled in by the author. */
  mustFill: string[];
  notes?: string[];
}

const localize = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const i18n = (globalThis as any).game?.i18n;
  if (!i18n || !value.includes('.')) return value;
  const out = i18n.localize(value);
  return out && out !== value ? out : value;
};

function resolveChoices(choices: unknown): string[] | undefined {
  let value = choices;
  if (typeof value === 'function') {
    try {
      value = (value as () => unknown)();
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') return Object.keys(value);
  return undefined;
}

function resolveDefault(field: FieldLike, name: string): unknown {
  const initial = field.initial ?? field.options?.initial;
  if (typeof initial === 'function') {
    if (name === 'id') return '<generated>';
    try {
      const out = initial.call(field, {});
      return out === undefined ? null : out;
    } catch {
      return null;
    }
  }
  return initial === undefined ? null : initial;
}

/** Describe one DataField (duck-typed so it can be unit-tested with plain objects). */
export function describeField(name: string, field: FieldLike): FieldDescription {
  const options = field.options ?? {};
  const out: FieldDescription = {
    name,
    kind: field.constructor?.name ?? 'DataField',
    required: field.required === true,
    nullable: field.nullable === true,
    default: resolveDefault(field, name),
  };

  const choices = resolveChoices(field.choices ?? options.choices);
  if (choices) out.choices = choices;
  if (typeof field.min === 'number') out.min = field.min;
  if (typeof field.max === 'number') out.max = field.max;
  if (field.integer === true) out.integer = true;
  const label = localize(field.label ?? options.label);
  if (label) out.label = label;
  const hint = localize(field.hint ?? options.hint);
  if (hint) out.hint = hint;
  const widget = options.widget;
  if (typeof widget === 'string') out.widget = widget;
  else if (typeof widget === 'function') out.widget = 'dynamic';
  if (typeof options.showWhen === 'function') out.conditional = true;

  if (field.fields && typeof field.fields === 'object') {
    out.fields = Object.entries(field.fields as Record<string, FieldLike>).map(([key, child]) =>
      describeField(key, child)
    );
  }
  if (field.element) {
    const element: Omit<FieldDescription, 'name'> & { name?: string } = describeField(
      'element',
      field.element
    );
    delete element.name;
    out.element = element;
  }
  return out;
}

/** Build a default-valued object for a described schema. */
export function buildTemplate(fields: FieldDescription[]): Record<string, unknown> {
  const template: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === 'id') continue;
    if (field.kind === 'ArrayField') template[field.name] = field.default ?? [];
    else if (field.fields && field.kind === 'SchemaField') {
      template[field.name] = buildTemplate(field.fields);
    } else template[field.name] = field.default;
  }
  return template;
}

/** Fields that default to an empty string/null but cannot work empty. */
function findMustFill(fields: FieldDescription[]): string[] {
  return fields
    .filter(
      f =>
        f.required &&
        !f.nullable &&
        f.kind === 'StringField' &&
        f.default === '' &&
        !['identifier', 'label'].includes(f.name)
    )
    .map(f => f.name);
}

/**
 * Behaviour that the field list cannot express, read from the system source.
 * Kept short and factual; every line cites where it comes from.
 */
export const RULE_NOTES: Record<string, string[]> = {
  chargePool: [
    'Only `character` actors track charge pools (utils/chargePool/helpers.ts isCharacterActor).',
    'initial is "max" | "zero" (NOT "full"); an invalid value force-disables the whole rule, so the pool does not exist and any chargeConsumer on it fails with poolMissing.',
    'The pool id is `actor:<identifier>` for scope "actor" and `<identifier>` for scope "item"; a consumer must name the same identifier AND the same scope. identifier falls back to the rule id when blank.',
    'max is a formula resolved against the actor roll data (e.g. "@will", "@level", "2"); a max that resolves to 0 makes the pool permanently empty and every consume fails with insufficientCharges.',
    'Recovery `mode`: "add" adds `value`, "set" sets to `value`, "refresh" fills to max (value is ignored). Triggers are only applied while the world setting automation.resourceRecovery is on.',
    'Rest recovery: a Safe Rest applies the safeRest entries and a Field Rest the fieldRest entries (nimble.restCompleted hook → applyRestRecovery).',
  ],
  chargeConsumer: [
    'Put it on the item whose activation should spend the charge. On use, Nimble validates then consumes every enabled consumer; a missing pool cancels the use ("poolMissing"), an empty pool cancels it ("insufficientCharges").',
    'poolIdentifier + poolScope must match a live chargePool (see chargePool notes). cost is a formula resolved against the actor roll data.',
    'A consumer whose predicate does not hold is skipped entirely (neither validates nor spends).',
    'Automation setting automation.resourceSpending controls automatic validation/consumption.',
  ],
  dicePool: [
    'Faces live in flags.nimble.dicePools; the current size is faces.length. Item-scoped pool id is the identifier, actor-scoped is `actor:<identifier>`.',
    'Refill `mode`: add, set, refresh, setIfEmpty, clear. Triggers include onAttacked and onCritReceived (not available to chargePool).',
  ],
  diceConsumer: [
    'mode "manual" spends dice on use; "autoBonus" adds every face to qualifying rolls without decrementing the pool.',
    'cardOffer ("hit" | "criticalHit") makes the owner a spendPoolForDamage offer on their own attack cards (visible in read-chat-log reactions); it requires effectType "generic" and selectionOutcome "consume".',
  ],
  modifyIncomingAttack: [
    "Consulted at attack time by the attacker's activation flow, only for the FIRST target of the attack, and only for tokens present on the viewed scene.",
    'disadvantage / forceReroll / autoMiss belong on the defender. redirectToSelf belongs on the protector: it offers them a reaction when an ALLIED, living token within `range` spaces is targeted (default range 2 is also the baseline Interpose range every character already has).',
    'range, automatic, rerollTrigger and rerollWithDisadvantage only matter for the modifier named in their showWhen (range: redirectToSelf; the others: forceReroll).',
    'An allied token with a matching redirectToSelf rule gets the rule-sourced offer instead of the baseline Interpose; range is measured in grid spaces between tokens at attack time.',
  ],
  damageReduction: [
    'mode "flat" subtracts `value` (a deterministic formula, no dice); "half" halves damage (resistance) and ignores value. Empty damageTypes means all damage types.',
  ],
};

/**
 * Validate a rule source against its data model. Returns the problems Nimble
 * itself would record (an invalid rule is force-disabled, never run).
 */
export function validateRuleSource(
  type: string,
  source: Record<string, unknown>
): { valid: boolean; problems: string[] } {
  const models = (globalThis as any).CONFIG?.NIMBLE?.ruleDataModels ?? {};
  const Cls = models[type];
  if (!Cls) return { valid: false, problems: [`Unknown rule type "${type}"`] };
  try {
    const rule = new Cls({ ...source, type }, { strict: true });
    if (!rule.invalid) return { valid: true, problems: [] };
    const failures: Array<{ unresolved?: boolean; toString(): string }> = Object.values(
      rule.validationFailures ?? {}
    );
    const problems = failures
      .filter(f => f?.unresolved)
      .map(f => String(f.toString()).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return { valid: false, problems: problems.length ? problems : ['Rule failed validation'] };
  } catch (error) {
    return { valid: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
}

export function describeNimbleRules(params: {
  type?: string;
  validate?: Record<string, unknown>;
}): Record<string, any> {
  requireNimble('describe-nimble-rules');
  const nimble = (globalThis as any).CONFIG?.NIMBLE;
  const models: Record<string, any> = nimble?.ruleDataModels ?? {};
  const labels: Record<string, string> = nimble?.ruleTypes ?? {};
  const types = Object.keys(models).sort();

  if (params.type && !models[params.type]) {
    throw new Error(`Unknown rule type "${params.type}". Known types: ${types.join(', ')}`);
  }

  const describeType = (type: string): RuleTypeDescription => {
    const Cls = models[type];
    const schema = Cls.schema?.fields ?? Cls.defineSchema();
    const fields = Object.entries(schema as Record<string, FieldLike>).map(([name, field]) =>
      describeField(name, field)
    );
    const out: RuleTypeDescription = {
      type,
      group: Cls.group ?? 'unsorted',
      description: localize(Cls.description) ?? null,
      label: localize(labels[type]) ?? null,
      fields,
      template: { ...buildTemplate(fields), type },
      mustFill: findMustFill(fields),
    };
    if (RULE_NOTES[type]) out.notes = RULE_NOTES[type];
    return out;
  };

  const result: Record<string, any> = {
    system: { id: (game as any).system?.id, version: (game as any).system?.version ?? null },
    baseFields:
      'Every rule also has: id, type, label, identifier, disabled, predicate (object), priority (number), suppressActivationCard ("auto"|"always"|"never").',
    note:
      'An invalid rule is still saved, but Nimble force-disables it and records the reason (see get-actor-resources). ' +
      'Unknown extra keys are ignored; a wrong enum value, wrong type or missing required value disables the rule.',
  };

  if (params.validate) {
    const ruleType = params.type ?? String(params.validate.type ?? '');
    if (!ruleType) throw new Error('validate needs `type` (or validate.type)');
    result.validation = { type: ruleType, ...validateRuleSource(ruleType, params.validate) };
  }

  if (params.type) {
    result.rule = describeType(params.type);
  } else {
    result.ruleTypes = types.map(describeType);
  }
  return result;
}
