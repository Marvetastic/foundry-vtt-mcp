/**
 * Combat-testing helpers (browser side): chat log reading, combat encounter
 * control, applying damage/healing, and Nimble item auto-roll.
 *
 * Nimble (v0.9.0) entry points used, per the system source (nimble-*.js.map):
 * - Item activation: NimbleBaseActor#activateItem / NimbleCharacter#activateItem
 *   (documents/actor/base.svelte.ts, character.ts) → item.activate(options) →
 *   ItemActivationManager (managers/ItemActivationManager.ts). `fastForward: true`
 *   skips the activation/upcast dialog; `rollMode` is the advantage count;
 *   `force: true` skips the "not enough actions" prompt (the action is still spent).
 * - Initiative: NimbleCombat#rollInitiative (documents/combat/combat.svelte.ts);
 *   no prompt unless `promptRollDialog`. In Nimble initiative sets a
 *   combatant's starting actions; turn order is the manual sort.
 * - Combatants: NimbleTokenDocument.createCombatants (documents/token/tokenDocument.ts)
 *   sets the combatant type (character / npc / minion / soloMonster).
 * - Damage from a card: NimbleChatMessage#applyAllDamage (documents/chatMessage.ts),
 *   the Apply Damage button: armor, immunity, resistance and flat reductions.
 * - Healing from a card: NimbleChatMessage#applyHealing(total, healingType, nodeId),
 *   the healing node's button; recorded in system.appliedHealing.
 * - Raw amounts: NimbleBaseActor#applyDamage (temp HP absorbs first) and
 *   #applyHealing(amount, 'healing' | 'tempHealing'). Dying, Wounds and
 *   Bloodied follow from Nimble's own actor-update hooks.
 */

import { parseChatMessage, selectChatMessages, type ParsedChatMessage } from './chat-log.js';

const NIMBLE = 'nimble';

/** fromUuidSync is missing from the bundled (v9) type definitions. */
export function fromUuidSyncSafe(uuid: string): any {
  try {
    return (globalThis as any).fromUuidSync?.(uuid) ?? null;
  } catch {
    return null;
  }
}

/** Array.from for Foundry collections, typed loosely like the rest of the bridge. */
export function toList(value: unknown): any[] {
  return Array.from((value ?? []) as Iterable<any>);
}

function isNimble(): boolean {
  return (game.system as any)?.id === NIMBLE;
}

export function requireNimble(tool: string): void {
  if (!isNimble()) {
    throw new Error(`${tool} requires the Nimble system (active: ${(game.system as any)?.id})`);
  }
}

// ─── shared lookups ──────────────────────────────────────────────────────────

export function chatResolvers() {
  return {
    actorName: (id: string) => (game as any).actors?.get(id)?.name ?? null,
    tokenName: (ref: string) => {
      if (ref.includes('.')) return fromUuidSyncSafe(ref)?.name ?? null;
      for (const scene of (game as any).scenes ?? []) {
        const token = scene.tokens?.get(ref);
        if (token) return token.name;
      }
      return null;
    },
    itemName: (uuid: string) => fromUuidSyncSafe(uuid)?.name ?? null,
    userName: (id: string) => (game as any).users?.get(id)?.name ?? null,
    uuidName: (uuid: string) => fromUuidSyncSafe(uuid)?.name ?? null,
    actorOwners: (actorUuid: string) => {
      const actor = fromUuidSyncSafe(actorUuid);
      const owner = (globalThis as any).CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
      return toList((game as any).users ?? [])
        .filter(u => !u.isGM && actor?.ownership?.[u.id] === owner)
        .map(u => u.name);
    },
    reactionRule: (itemUuid: string, ruleId: string) => {
      const item = fromUuidSyncSafe(itemUuid);
      const rule = item?.rules
        ? toList(item.rules.values?.() ?? item.rules).find(r => r.id === ruleId)
        : null;
      return rule
        ? { modifier: rule.modifier, range: rule.range, disabled: rule.disabled === true }
        : null;
    },
  };
}

export function parseMessage(message: any, includeRolls = true): ParsedChatMessage {
  const source = message.toObject ? message.toObject() : message;
  return parseChatMessage(
    { ...source, id: message.id ?? source._id },
    { includeRolls, resolvers: chatResolvers() }
  );
}

function resolveScene(identifier?: string): any {
  const scenes = (game as any).scenes;
  if (!identifier) {
    const scene = (globalThis as any).canvas?.scene ?? scenes?.active;
    if (!scene) throw new Error('No active or viewed scene');
    return scene;
  }
  const scene = scenes?.get(identifier) ?? scenes?.find((s: any) => s.name === identifier);
  if (!scene) throw new Error(`Scene not found: ${identifier}`);
  return scene;
}

/**
 * Resolve token ids or names (token name, then actor name) on a scene.
 * Ambiguous names are refused with the candidate ids.
 */
export function resolveSceneTokens(scene: any, identifiers: string[]): any[] {
  const tokens = toList(scene.tokens ?? []);
  return identifiers.map(identifier => {
    const byId = scene.tokens?.get?.(identifier) ?? tokens.find(t => t.id === identifier);
    if (byId) return byId;
    if (identifier.includes('.')) {
      const byUuid = tokens.find(t => t.uuid === identifier);
      if (byUuid) return byUuid;
    }
    const lower = identifier.toLowerCase();
    let matches = tokens.filter(t => (t.name ?? '').toLowerCase() === lower);
    if (matches.length === 0) {
      matches = tokens.filter(t => (t.actor?.name ?? '').toLowerCase() === lower);
    }
    if (matches.length === 0) {
      throw new Error(`Token not found on scene "${scene.name}": ${identifier}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `"${identifier}" matches ${matches.length} tokens on "${scene.name}"; pass token ids: ${matches
          .map(t => `${t.id} (${t.name})`)
          .join(', ')}`
      );
    }
    return matches[0];
  });
}

/** HP / wounds / conditions snapshot used for before/after reporting. */
export function actorStateSnapshot(actor: any): Record<string, any> {
  const hp = actor?.system?.attributes?.hp ?? {};
  const wounds = actor?.system?.attributes?.wounds;
  return {
    hp: { value: hp.value ?? null, max: hp.max ?? null, temp: hp.temp ?? 0 },
    ...(wounds ? { wounds: { value: wounds.value ?? 0, max: wounds.max ?? null } } : {}),
    conditions: Array.from(actor?.statuses ?? []).sort(),
  };
}

/** Let Nimble's follow-up hooks (dying, wounds, bloodied) settle before reading state. */
export function settle(ms = 300): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── read-chat-log ───────────────────────────────────────────────────────────

export function readChatLog(params: {
  limit?: number;
  sinceMessageId?: string;
  sinceTimestamp?: number;
  speaker?: string;
  includeRolls?: boolean;
}): { messages: ParsedChatMessage[]; total: number; latestMessageId: string | null } {
  const all = toList((game as any).messages?.contents ?? (game as any).messages ?? []);
  all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  const selected = selectChatMessages(
    all,
    {
      limit: params.limit ?? 20,
      ...(params.sinceMessageId ? { sinceMessageId: params.sinceMessageId } : {}),
      ...(params.sinceTimestamp !== undefined ? { sinceTimestamp: params.sinceTimestamp } : {}),
      ...(params.speaker ? { speaker: params.speaker } : {}),
    },
    (message, speaker) => {
      const s = message.speaker ?? {};
      const lower = speaker.toLowerCase();
      const actorName = s.actor ? (game as any).actors?.get(s.actor)?.name : null;
      return (
        s.actor === speaker ||
        s.token === speaker ||
        (s.alias ?? '').toLowerCase() === lower ||
        (actorName ?? '').toLowerCase() === lower
      );
    }
  );

  return {
    messages: selected.map(m => parseMessage(m, params.includeRolls ?? true)),
    total: all.length,
    latestMessageId: all.length > 0 ? (all[all.length - 1].id ?? null) : null,
  };
}

// ─── manage-combat ───────────────────────────────────────────────────────────

function resolveCombat(combatId?: string): any {
  const combats = (game as any).combats;
  const combat = combatId ? combats?.get(combatId) : ((game as any).combat ?? combats?.viewed);
  if (!combat) {
    throw new Error(combatId ? `Combat not found: ${combatId}` : 'No active combat encounter');
  }
  return combat;
}

function resolveCombatants(combat: any, identifiers?: string[]): any[] {
  const combatants = toList(combat.combatants ?? []);
  if (!identifiers || identifiers.length === 0) return combatants;
  return identifiers.map(identifier => {
    const lower = identifier.toLowerCase();
    const matches = combatants.filter(
      c =>
        c.id === identifier ||
        c.tokenId === identifier ||
        c.actorId === identifier ||
        (c.name ?? '').toLowerCase() === lower ||
        (c.token?.name ?? '').toLowerCase() === lower
    );
    if (matches.length === 0) throw new Error(`Combatant not found: ${identifier}`);
    if (matches.length > 1) {
      throw new Error(
        `"${identifier}" matches ${matches.length} combatants; pass combatant ids: ${matches
          .map(c => `${c.id} (${c.name})`)
          .join(', ')}`
      );
    }
    return matches[0];
  });
}

function combatantSummary(combatant: any): Record<string, any> {
  const actions = combatant.system?.actions?.base;
  return {
    id: combatant.id,
    name: combatant.name,
    tokenId: combatant.tokenId ?? null,
    actorId: combatant.actorId ?? null,
    type: combatant.type ?? null,
    initiative: combatant.initiative ?? null,
    defeated: combatant.isDefeated ?? combatant.defeated ?? false,
    hidden: combatant.hidden ?? false,
    ...actorStateSnapshot(combatant.actor),
    ...(actions
      ? {
          actions: {
            current: actions.current ?? 0,
            max: actions.max ?? null,
            additional: actions.additional ?? 0,
          },
        }
      : {}),
  };
}

export function combatSummary(combat: any): Record<string, any> {
  const turns = (combat.turns ?? []) as any[];
  const inOrder = new Set(turns.map(c => c.id));
  const current = combat.combatant;
  return {
    id: combat.id,
    sceneId: combat.scene?.id ?? null,
    active: combat.active ?? false,
    started: combat.started ?? (combat.round ?? 0) > 0,
    round: combat.round ?? 0,
    turn: combat.turn ?? null,
    current: current ? { combatantId: current.id, name: current.name } : null,
    order: turns.map(combatantSummary),
    notInTurnOrder: toList(combat.combatants ?? [])
      .filter(c => !inOrder.has(c.id))
      .map(combatantSummary),
    ...(isNimble()
      ? {
          note: 'Nimble: initiative sets starting actions; turn order follows the manual combatant sort. Dead combatants are skipped.',
        }
      : {}),
  };
}

export async function manageCombat(params: {
  action: string;
  combatId?: string;
  scene?: string;
  tokens?: string[];
  combatants?: string[];
  confirm?: boolean;
}): Promise<any> {
  switch (params.action) {
    case 'create': {
      if (!params.tokens || params.tokens.length === 0) {
        throw new Error('tokens is required for "create"');
      }
      const scene = resolveScene(params.scene);
      const tokens = resolveSceneTokens(scene, params.tokens);
      const CombatClass = (getDocumentClass as any)('Combat');
      const combat = await CombatClass.create({ scene: scene.id, active: true });

      const TokenClass = (getDocumentClass as any)('Token');
      const canvasSceneId = (globalThis as any).canvas?.scene?.id;
      if (typeof TokenClass?.createCombatants === 'function' && canvasSceneId === scene.id) {
        await TokenClass.createCombatants(tokens, { combat });
      } else {
        await combat.createEmbeddedDocuments(
          'Combatant',
          tokens.map(token => ({
            tokenId: token.id,
            sceneId: scene.id,
            actorId: token.actorId,
            hidden: token.hidden ?? false,
            ...(typeof TokenClass?.getCombatantType === 'function'
              ? { type: TokenClass.getCombatantType(token) }
              : {}),
          }))
        );
      }
      return combatSummary(combat);
    }
    case 'roll-initiative': {
      const combat = resolveCombat(params.combatId);
      const ids = resolveCombatants(combat, params.combatants).map(c => c.id);
      await combat.rollInitiative(ids);
      return combatSummary(combat);
    }
    case 'start': {
      const combat = resolveCombat(params.combatId);
      await combat.startCombat();
      return combatSummary(combat);
    }
    case 'next-turn': {
      const combat = resolveCombat(params.combatId);
      await combat.nextTurn();
      return combatSummary(combat);
    }
    case 'get':
      return combatSummary(resolveCombat(params.combatId));
    case 'end': {
      if (params.confirm !== true) {
        throw new Error('Refusing to end combat: "confirm: true" is required');
      }
      const combat = resolveCombat(params.combatId);
      const id = combat.id;
      await combat.delete();
      return { deleted: true, combatId: id };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}

// ─── apply-to-token ──────────────────────────────────────────────────────────

export async function applyToToken(params: {
  tokens?: string[];
  scene?: string;
  amount?: number;
  kind?: 'damage' | 'healing' | 'tempHealing';
  damageType?: string;
  fromChatMessageId?: string;
}): Promise<any> {
  requireNimble('apply-to-token');

  const notes: string[] = [];

  if (params.fromChatMessageId) {
    const message = (game as any).messages?.get(params.fromChatMessageId);
    if (!message) throw new Error(`Chat message not found: ${params.fromChatMessageId}`);
    if (typeof message.applyAllDamage !== 'function' || !message.system?.activation) {
      throw new Error('That chat message is not a Nimble activation card');
    }

    if (params.tokens && params.tokens.length > 0) {
      const scene = resolveScene(params.scene);
      const uuids = resolveSceneTokens(scene, params.tokens).map(t => t.uuid);
      // Same field the card's own target controls write.
      await message.update({ 'system.targets': uuids });
    }

    const targetUuids: string[] = message.system?.targets ?? [];
    if (targetUuids.length === 0) {
      throw new Error('The chat card has no targets; pass tokens to set them');
    }
    const targets = targetUuids
      .map(uuid => fromUuidSyncSafe(uuid))
      .filter((doc: any) => doc?.actor);
    const before = targets.map((t: any) => actorStateSnapshot(t.actor));

    const parsed = parseMessage(message);
    const effects = parsed.nimble?.effects ?? [];
    const wantDamage = !params.kind || params.kind === 'damage';
    const healingTypes = params.kind ? [params.kind] : ['healing', 'tempHealing'];
    const applied: Array<Record<string, any>> = [];

    if (wantDamage && effects.some(e => e.type === 'damage' && (e.amount ?? 0) > 0)) {
      await message.applyAllDamage();
      applied.push({ kind: 'damage', via: 'applyAllDamage' });
    }
    for (const effect of effects) {
      if (effect.type !== 'healing' || !effect.applies || !effect.roll || !effect.id) continue;
      const healingType = effect.healingType ?? 'healing';
      if (!healingTypes.includes(healingType)) continue;
      if (message.isHealingApplied?.(effect.id)) {
        notes.push(`Healing node ${effect.id} was already applied on this card; skipped.`);
        continue;
      }
      await message.applyHealing(effect.roll.total, healingType, effect.id);
      applied.push({ kind: healingType, amount: effect.roll.total, effectId: effect.id });
    }
    if (applied.length === 0) notes.push('Nothing on the card matched; no changes were made.');

    await settle();
    return {
      mode: 'chat-card',
      messageId: message.id,
      applied,
      targets: targets.map((t: any, i: number) => ({
        uuid: t.uuid,
        name: t.name,
        before: before[i],
        after: actorStateSnapshot(t.actor),
      })),
      notes,
    };
  }

  if (!params.tokens || params.tokens.length === 0) throw new Error('tokens is required');
  if (!params.kind) throw new Error('kind is required when not using fromChatMessageId');
  const amount = Math.floor(Number(params.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');

  const scene = resolveScene(params.scene);
  const tokens = resolveSceneTokens(scene, params.tokens);
  if (params.kind === 'damage') {
    notes.push(
      `Raw damage via actor.applyDamage: temp HP absorbs first. Nimble resolves armor, ` +
        `resistances and immunities from the roll on a chat card, so they are NOT applied here; ` +
        `use fromChatMessageId for that.${
          params.damageType ? ` damageType "${params.damageType}" is informational only.` : ''
        }`
    );
  }

  const results = [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) throw new Error(`Token ${token.name} has no actor`);
    const before = actorStateSnapshot(actor);
    if (params.kind === 'damage') await actor.applyDamage(amount);
    else await actor.applyHealing(amount, params.kind);
    results.push({ token, before });
  }
  await settle();

  return {
    mode: 'amount',
    kind: params.kind,
    amount,
    targets: results.map(({ token, before }) => ({
      tokenId: token.id,
      name: token.name,
      before,
      after: actorStateSnapshot(token.actor),
    })),
    notes,
  };
}

// ─── use-item auto-roll (Nimble) ─────────────────────────────────────────────

export async function nimbleAutoRollItem(
  actor: any,
  item: any,
  options: { advantage?: number; rollHidden?: boolean }
): Promise<{
  messageIds: string[];
  messages: ParsedChatMessage[];
  actionsBefore: number | null;
  cancelled: boolean;
}> {
  requireNimble('use-item autoRoll');

  if (item.type === 'object' && item.flags?.nimble?.spellScroll) {
    throw new Error(
      'Spell scrolls always open a confirmation/Arcana prompt in Nimble; autoRoll cannot use them'
    );
  }
  if (typeof actor.activateItem !== 'function') {
    throw new Error('Actor has no activateItem method; is this a Nimble actor?');
  }

  const before = new Set<string>(toList((game as any).messages?.contents ?? []).map(m => m.id));

  const combat = (game as any).combat;
  const combatant = combat?.combatants?.find((c: any) => c.actorId === actor.id);
  const actionsBefore = combatant?.system?.actions?.base?.current ?? null;

  const card = await actor.activateItem(item.id, {
    fastForward: true,
    rollMode: options.advantage ?? 0,
    ...(options.rollHidden !== undefined ? { rollHidden: options.rollHidden } : {}),
    // Skip the insufficient-actions prompt; the action is still deducted.
    force: true,
  });

  // Follow-up cards (reactions, pool gains) may land just after the activation card.
  await settle(200);
  const created = toList((game as any).messages?.contents ?? []).filter(m => !before.has(m.id));
  if (card && !created.some(m => m.id === card.id)) created.unshift(card);

  return {
    messageIds: created.map(m => m.id),
    messages: created.map(m => parseMessage(m)),
    actionsBefore,
    cancelled: card === null && created.length === 0,
  };
}
