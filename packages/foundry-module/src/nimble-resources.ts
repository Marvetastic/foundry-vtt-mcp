/**
 * Nimble actor resources (browser side): charge pools, dice pools, rules that
 * are not running, active toggles — and resting.
 *
 * Nimble (v0.9.0) data, per the system source maps (nimble-*.js.map):
 * - Charge pools: flags.nimble.chargePools on the ACTOR for scope "actor" (ids
 *   `actor:<identifier>`) and on the owning ITEM for scope "item" (id =
 *   identifier). State: { current, max, dieSize, label, hidden, recoveries... }
 *   (utils/chargePool/helpers.ts getChargePoolMapFromActor).
 * - Dice pools: flags.nimble.dicePools, same layout; state holds `faces`, the
 *   dice currently in the pool (utils/dicePool/helpers.ts).
 * - Rules: item.system.rules is the authored source; item.rules is the live
 *   RulesManager (a Map of built rules) with `failures` and `failureFor(id)`
 *   explaining why a rule is not running (managers/RulesManager.ts). A rule that
 *   fails validation is force-disabled by NimbleBaseRule's constructor.
 * - Toggles: active effects carrying flags.nimble.toggleEffectRuleId
 *   (models/rules/toggleEffect.ts).
 * - Rest: NimbleCharacter#triggerRest({ restType, skipChatCard: true }) skips the
 *   dialog and the chat card (documents/actor/character.ts) and runs
 *   RestManager#rest, then calls nimble.restCompleted, whose listener
 *   (hooks/chargeSystem.ts) applies the pools' safeRest / fieldRest recoveries.
 */

import { actorStateSnapshot, fromUuidSyncSafe, requireNimble, toList } from './combat-tools.js';

const SYSTEM = 'nimble';

const POOL_RULE_TYPES = new Set(['chargePool', 'dicePool', 'chargeConsumer', 'diceConsumer']);

const AUTOMATION_KEYS = [
  'automation.applyRuleEffects',
  'automation.resourceRecovery',
  'automation.resourceSpending',
  'automation.actionTracking',
] as const;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Resolve an actor by id, uuid (actor or token) or case-insensitive unique name. */
export function resolveActor(identifier: string): any {
  const actors = (game as any).actors;
  const byId = actors?.get?.(identifier);
  if (byId) return byId;
  if (identifier.includes('.')) {
    const doc = fromUuidSyncSafe(identifier);
    const actor = doc?.documentName === 'Actor' ? doc : doc?.actor;
    if (actor) return actor;
  }
  const lower = identifier.toLowerCase();
  const matches = toList(actors ?? []).filter(a => (a.name ?? '').toLowerCase() === lower);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `"${identifier}" matches ${matches.length} actors; pass an id: ${matches
        .map(a => `${a.id} (${a.name})`)
        .join(', ')}`
    );
  }
  throw new Error(`Actor not found: ${identifier}`);
}

// ─── pools ───────────────────────────────────────────────────────────────────

interface PoolOwner {
  id: string | null;
  name: string | null;
}

function poolEntries(
  actor: any,
  flagKey: 'chargePools' | 'dicePools'
): Array<{ key: string; scope: 'actor' | 'item'; owner: PoolOwner; state: Record<string, any> }> {
  const out: Array<{ key: string; scope: 'actor' | 'item'; owner: PoolOwner; state: any }> = [];

  for (const [key, state] of Object.entries(asRecord(actor?.flags?.[SYSTEM]?.[flagKey]))) {
    const s = asRecord(state);
    if (!key.startsWith('actor:') || !Object.keys(s).length) continue;
    out.push({
      key,
      scope: 'actor',
      owner: { id: s.sourceItemId || null, name: s.sourceItemName || null },
      state: s,
    });
  }
  for (const item of toList(actor?.items ?? [])) {
    for (const [key, state] of Object.entries(asRecord(item?.flags?.[SYSTEM]?.[flagKey]))) {
      const s = asRecord(state);
      if (!Object.keys(s).length) continue;
      out.push({
        key,
        scope: 'item',
        owner: { id: item.id ?? null, name: item.name ?? null },
        state: s,
      });
    }
  }
  return out;
}

export interface ChargePoolInfo {
  poolId: string;
  identifier: string;
  scope: 'actor' | 'item';
  owningItem: PoolOwner;
  label: string;
  current: number;
  max: number;
  dieSize: string | null;
  hidden: boolean;
  recoveries: Array<{ trigger: string; mode: string; value: string }>;
}

export interface DicePoolInfo {
  poolId: string;
  identifier: string;
  scope: 'actor' | 'item';
  owningItem: PoolOwner;
  label: string;
  current: number;
  max: number;
  dieSize: string | null;
  /** The dice currently in the pool, in order (indices are what use-reaction's spend takes). */
  faces: number[];
  minFace: number | null;
  consumption: string | null;
  refills: Array<{ trigger: string; mode: string; value: string }>;
}

export function collectChargePools(actor: any): ChargePoolInfo[] {
  return poolEntries(actor, 'chargePools').map(({ key, scope, owner, state }) => ({
    poolId: key,
    identifier: String(state.identifier || key.replace(/^actor:/, '')),
    scope,
    owningItem: owner,
    label: String(state.label || owner.name || key),
    current: num(state.current),
    max: num(state.max),
    dieSize: state.dieSize ?? null,
    hidden: state.hidden === true,
    recoveries: (Array.isArray(state.recoveries) ? state.recoveries : []).map((r: any) => ({
      trigger: String(r?.trigger),
      mode: String(r?.mode),
      value: String(r?.value ?? ''),
    })),
  }));
}

export function collectDicePools(actor: any): DicePoolInfo[] {
  return poolEntries(actor, 'dicePools').map(({ key, scope, owner, state }) => {
    const faces = (Array.isArray(state.faces) ? state.faces : []).map(num);
    return {
      poolId: key,
      identifier: String(state.identifier || key.replace(/^actor:/, '')),
      scope,
      owningItem: owner,
      label: String(state.label || owner.name || key),
      current: faces.length,
      max: num(state.max),
      dieSize: state.dieSize ?? null,
      faces,
      minFace: state.minFace === undefined || state.minFace === null ? null : num(state.minFace),
      consumption: state.consumption ?? null,
      refills: (Array.isArray(state.refills) ? state.refills : []).map((r: any) => ({
        trigger: String(r?.trigger),
        mode: String(r?.mode),
        value: String(r?.value ?? ''),
      })),
    };
  });
}

// ─── rules ───────────────────────────────────────────────────────────────────

export interface RuleStatus {
  itemId: string | null;
  itemName: string | null;
  ruleId: string;
  type: string;
  label: string;
  /** invalid = failed validation or could not be built (Nimble force-disabled it); disabled = switched off by its author. */
  status: 'invalid' | 'disabled';
  reason: string;
}

export interface ResourceRuleStatus {
  itemId: string | null;
  itemName: string | null;
  ruleId: string;
  type: string;
  label: string;
  identifier: string;
  scope: string | null;
  running: boolean;
  /** false when the rule's predicate does not currently hold (a pool whose predicate fails does not exist). */
  predicateMet: boolean | null;
  /** chargePool/dicePool: whether the pool has stored state. chargeConsumer/diceConsumer: whether the pool it names exists. */
  poolExists: boolean;
  poolId: string;
  problem?: string;
}

function ruleFailure(item: any, ruleId: string): string | undefined {
  const manager = item?.rules;
  if (!manager) return undefined;
  if (typeof manager.failureFor === 'function') {
    const text = manager.failureFor(ruleId);
    if (text) return String(text);
  }
  const failure = manager.failures?.get?.(ruleId);
  if (failure) return String(failure.text ?? failure.key ?? 'rule failed to build');
  return undefined;
}

function poolIdFor(scope: unknown, identifier: string): string {
  return scope === 'actor' ? `actor:${identifier}` : identifier;
}

export function collectRuleStatus(
  actor: any,
  poolIds: { charge: Set<string>; dice: Set<string> }
): { problems: RuleStatus[]; resourceRules: ResourceRuleStatus[]; totalRules: number } {
  const problems: RuleStatus[] = [];
  const resourceRules: ResourceRuleStatus[] = [];
  let totalRules = 0;

  for (const item of toList(actor?.items ?? [])) {
    const sources: any[] = Array.isArray(item?.system?.rules) ? item.system.rules : [];
    for (const source of sources) {
      totalRules += 1;
      const ruleId = String(source?.id ?? '');
      const type = String(source?.type ?? 'unknown');
      const live = item.rules?.get?.(ruleId);
      const failure = ruleFailure(item, ruleId);
      const base = {
        itemId: item.id ?? null,
        itemName: item.name ?? null,
        ruleId,
        type,
        label: String(source?.label ?? ''),
      };

      let running = true;
      if (failure) {
        running = false;
        problems.push({ ...base, status: 'invalid', reason: failure });
      } else if (live && live.disabled === true && source?.disabled !== true) {
        running = false;
        problems.push({
          ...base,
          status: 'invalid',
          reason: 'Disabled by Nimble although the source is enabled (validation failed).',
        });
      } else if (source?.disabled === true || live?.disabled === true) {
        running = false;
        problems.push({
          ...base,
          status: 'disabled',
          reason: 'Switched off in the rule source (disabled: true).',
        });
      } else if (!live && item.rules) {
        running = false;
        problems.push({
          ...base,
          status: 'invalid',
          reason: 'Nimble did not build this rule and recorded no reason.',
        });
      }

      if (!POOL_RULE_TYPES.has(type)) continue;
      const isConsumer = type.endsWith('Consumer');
      const identifier = String(
        (isConsumer ? source.poolIdentifier : source.identifier) || source.id || ''
      );
      const scope = (isConsumer ? source.poolScope : source.scope) ?? null;
      const poolId = poolIdFor(scope, identifier);
      const known = type.startsWith('charge') ? poolIds.charge : poolIds.dice;
      const entry: ResourceRuleStatus = {
        ...base,
        identifier,
        scope,
        running,
        predicateMet:
          running && typeof live?.appliesTo === 'function' ? live.appliesTo() !== false : null,
        poolExists: known.has(poolId),
        poolId,
      };
      if (isConsumer && !entry.poolExists) {
        entry.problem = `No ${type.startsWith('charge') ? 'charge' : 'dice'} pool "${poolId}" exists on this actor, so activating this item is cancelled (poolMissing).`;
      } else if (!isConsumer && running && !entry.poolExists) {
        entry.problem =
          entry.predicateMet === false
            ? 'Predicate not met: the pool does not exist yet.'
            : 'Pool has no stored state yet (it appears when Nimble next syncs the actor).';
      } else if (!running) {
        entry.problem = 'Rule is not running, so it neither creates nor spends a pool.';
      }
      resourceRules.push(entry);
    }
  }
  return { problems, resourceRules, totalRules };
}

// ─── toggles ─────────────────────────────────────────────────────────────────

export function collectToggles(actor: any): {
  active: Array<{ effectId: string; name: string; ruleId: string; itemId: string | null }>;
  inactiveCount: number;
} {
  const active: Array<{ effectId: string; name: string; ruleId: string; itemId: string | null }> =
    [];
  let inactiveCount = 0;
  for (const effect of toList(actor?.effects ?? [])) {
    const flags = asRecord(effect?.flags?.[SYSTEM]);
    if (!flags.toggleEffectRuleId) continue;
    if (effect.disabled === true) {
      inactiveCount += 1;
      continue;
    }
    active.push({
      effectId: effect.id,
      name: effect.name ?? effect.label ?? '',
      ruleId: String(flags.toggleEffectRuleId),
      itemId: flags.toggleEffectItemId ?? null,
    });
  }
  return { active, inactiveCount };
}

function readAutomation(): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const key of AUTOMATION_KEYS) {
    try {
      const value = (game as any).settings?.get(SYSTEM, key);
      out[key] = value === undefined ? null : Boolean(value);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

export function collectActorResources(actor: any): Record<string, any> {
  const chargePools = collectChargePools(actor);
  const dicePools = collectDicePools(actor);
  const status = collectRuleStatus(actor, {
    charge: new Set(chargePools.map(p => p.poolId)),
    dice: new Set(dicePools.map(p => p.poolId)),
  });
  const toggles = collectToggles(actor);

  return {
    actor: { id: actor?.id ?? null, name: actor?.name ?? null, type: actor?.type ?? null },
    ...(actor?.type !== 'character'
      ? { note: 'Nimble only tracks charge and dice pools for character actors.' }
      : {}),
    chargePools,
    dicePools,
    rules: {
      total: status.totalRules,
      problems: status.problems,
      resourceRules: status.resourceRules,
    },
    activeToggles: toggles.active,
    inactiveToggleCount: toggles.inactiveCount,
    automation: readAutomation(),
  };
}

export function getActorResources(params: { actor: string }): Record<string, any> {
  requireNimble('get-actor-resources');
  return collectActorResources(resolveActor(params.actor));
}

// ─── rest ────────────────────────────────────────────────────────────────────

function restSnapshot(actor: any): Record<string, any> {
  const attrs = actor?.system?.attributes ?? {};
  const mana = actor?.system?.resources?.mana;
  return {
    hp: num(attrs.hp?.value),
    tempHp: num(attrs.hp?.temp),
    wounds: num(attrs.wounds?.value),
    ...(mana ? { mana: num(mana.current) } : {}),
    hitDice: JSON.parse(JSON.stringify(attrs.hitDice ?? {})),
    chargePools: Object.fromEntries(collectChargePools(actor).map(p => [p.poolId, p.current])),
    dicePools: Object.fromEntries(collectDicePools(actor).map(p => [p.poolId, p.faces])),
  };
}

/** Compare two rest snapshots and list what changed. */
export function diffRestSnapshots(
  before: Record<string, any>,
  after: Record<string, any>
): Record<string, any> {
  const changes: Record<string, any> = {};
  for (const key of ['hp', 'tempHp', 'wounds', 'mana']) {
    if (before[key] !== undefined && before[key] !== after[key]) {
      changes[key] = { before: before[key], after: after[key] };
    }
  }
  const hitDice: Record<string, any> = {};
  for (const size of new Set([...Object.keys(before.hitDice), ...Object.keys(after.hitDice)])) {
    const b = JSON.stringify(before.hitDice[size] ?? null);
    const a = JSON.stringify(after.hitDice[size] ?? null);
    if (a !== b)
      hitDice[size] = { before: before.hitDice[size] ?? null, after: after.hitDice[size] ?? null };
  }
  if (Object.keys(hitDice).length) changes.hitDice = hitDice;

  const chargePools: Record<string, any> = {};
  for (const id of new Set([
    ...Object.keys(before.chargePools),
    ...Object.keys(after.chargePools),
  ])) {
    if (before.chargePools[id] !== after.chargePools[id]) {
      chargePools[id] = {
        before: before.chargePools[id] ?? null,
        after: after.chargePools[id] ?? null,
      };
    }
  }
  if (Object.keys(chargePools).length) changes.chargePools = chargePools;

  const dicePools: Record<string, any> = {};
  for (const id of new Set([...Object.keys(before.dicePools), ...Object.keys(after.dicePools)])) {
    const b = JSON.stringify(before.dicePools[id] ?? null);
    const a = JSON.stringify(after.dicePools[id] ?? null);
    if (a !== b)
      dicePools[id] = { before: before.dicePools[id] ?? null, after: after.dicePools[id] ?? null };
  }
  if (Object.keys(dicePools).length) changes.dicePools = dicePools;
  return changes;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function restActor(params: {
  actor: string;
  restType: 'safe' | 'field';
}): Promise<Record<string, any>> {
  requireNimble('rest');
  const actor = resolveActor(params.actor);
  if (typeof actor.triggerRest !== 'function') {
    throw new Error(`${actor.name} cannot rest (Nimble only lets character actors rest)`);
  }

  const before = restSnapshot(actor);
  const stateBefore = actorStateSnapshot(actor);

  // skipChatCard makes triggerRest skip its dialog; default options mean no hit dice
  // are spent on a Field Rest and no camp. It also skips the rest chat card.
  await actor.triggerRest({ restType: params.restType, skipChatCard: true });

  // restCompleted listeners (pool recovery) run un-awaited; wait for the state to settle.
  let after = restSnapshot(actor);
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    const next = restSnapshot(actor);
    const stable = JSON.stringify(next) === JSON.stringify(after);
    after = next;
    if (stable && i >= 1) break;
  }

  const automation = readAutomation();
  return {
    actor: { id: actor.id, name: actor.name },
    restType: params.restType,
    options: { skipChatCard: true, makeCamp: false, hitDiceSpent: {} },
    restored: diffRestSnapshots(before, after),
    stateBefore,
    stateAfter: actorStateSnapshot(actor),
    ...(automation['automation.resourceRecovery'] === false
      ? {
          warning:
            'World setting automation.resourceRecovery is off: pools do not recover from rest triggers.',
        }
      : {}),
    note: 'No rest chat card is posted (Nimble skips its dialog and card together).',
  };
}
