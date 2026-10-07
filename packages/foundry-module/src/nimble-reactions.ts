/**
 * use-reaction (browser side): take an offer from a Nimble attack card exactly
 * as the card's button does.
 *
 * Nimble (v0.9.0) path, per the system source maps (nimble-*.js.map):
 * - view/chat/components/IncomingReactionPrompts.svelte  useEntry(): for a
 *   baseline Interpose in a STARTED combat it first spends the combatant's
 *   interpose heroic reaction (and its action cost) with
 *   combat.useHeroicReactions(combatantId, ['interpose']); a soft block (reaction
 *   already spent, not enough actions, it is their own turn) asks for a
 *   confirmation and retries with { force: true }. Rule-granted offers leave
 *   their cost to the granting feature. Then it calls
 *   utils/incomingAttackReactions.ts requestIncomingAttackReaction, which for a
 *   GM calls the message's resolver directly.
 * - documents/chatMessage.ts  resolveRedirectReaction / resolveForceRerollReaction /
 *   resolveSpendPoolForDamageOffer: GM-only, serialized per card. They validate
 *   and then silently return when something is off (the refusal is only a UI
 *   notification), so success is read back from the card: the entry must be
 *   `used` afterwards.
 */

import {
  chatResolvers,
  fromUuidSyncSafe,
  parseMessage,
  requireNimble,
  settle,
  toList,
  actorStateSnapshot,
} from './combat-tools.js';
import { parseIncomingReactions, type ReactionOffer } from './chat-log.js';
import { resolveActor } from './nimble-resources.js';

export interface UseReactionParams {
  messageId: string;
  /** Offer index (number) or button label / id / unique label substring. */
  offer: number | string;
  /** The actor taking the reaction; must be the offer's reacting actor. */
  actor?: string;
  /** Confirm the "reaction already spent / not enough actions / own turn" prompt, like clicking Confirm. */
  force?: boolean;
  /** Required for spendPoolForDamage: which dice (indices into the pool's faces) to spend. */
  spend?: { faceIndices: number[] };
}

/** Pick an offer by index, id or label; ambiguous labels are refused. */
export function selectOffer(offers: ReactionOffer[], wanted: number | string): ReactionOffer {
  if (typeof wanted === 'number') {
    const byIndex = offers[wanted];
    if (!byIndex) {
      throw new Error(`No offer at index ${wanted}; the card has ${offers.length} offer(s)`);
    }
    return byIndex;
  }
  const lower = wanted.toLowerCase();
  const byId = offers.find(o => o.id === wanted);
  if (byId) return byId;
  const exact = offers.filter(o => o.label.toLowerCase() === lower);
  const matches = exact.length ? exact : offers.filter(o => o.label.toLowerCase().includes(lower));
  if (matches.length === 0) {
    throw new Error(
      `No offer matches "${wanted}". Offers: ${offers.map(o => `[${o.index}] ${o.label}`).join('; ') || '(none)'}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${wanted}" matches ${matches.length} offers; use the index: ${matches
        .map(o => `[${o.index}] ${o.label}`)
        .join('; ')}`
    );
  }
  return matches[0];
}

function targetsOf(message: any): Array<{ uuid: string; name: string | null }> {
  const uuids: string[] = Array.isArray(message?.system?.targets) ? message.system.targets : [];
  return uuids.map(uuid => ({ uuid, name: fromUuidSyncSafe(uuid)?.name ?? null }));
}

function offerStates(message: any): Array<{ index: number; id: string; used: boolean }> {
  const entries: any[] = Array.isArray(message?.system?.incomingReactions)
    ? message.system.incomingReactions
    : [];
  return entries.map((e, index) => ({ index, id: String(e?.id ?? ''), used: e?.used === true }));
}

function actorOfToken(uuid: string | null | undefined): any {
  if (!uuid) return null;
  const doc = fromUuidSyncSafe(uuid);
  return doc?.actor ?? null;
}

/** Combatant (if any) in the started combat for an offer's token. */
function combatantFor(combat: any, tokenUuid: string | null | undefined): any {
  if (!combat?.started || !tokenUuid) return null;
  const tokenId = fromUuidSyncSafe(tokenUuid)?.id ?? tokenUuid.split('.').pop();
  return toList(combat.combatants ?? []).find(c => c.tokenId === tokenId) ?? null;
}

function combatantSnapshot(combatant: any): Record<string, any> | null {
  if (!combatant) return null;
  return {
    combatantId: combatant.id,
    name: combatant.name,
    system: JSON.parse(JSON.stringify(combatant.system?.actions ?? {})),
    reactions: JSON.parse(JSON.stringify(combatant.system?.reactions ?? null)),
  };
}

export async function useReaction(params: UseReactionParams): Promise<Record<string, any>> {
  requireNimble('use-reaction');
  if (!(game as any).user?.isGM) throw new Error('use-reaction is GM-only');

  const message = (game as any).messages?.get(params.messageId);
  if (!message) throw new Error(`Chat message not found: ${params.messageId}`);
  const raw: any[] = Array.isArray(message.system?.incomingReactions)
    ? message.system.incomingReactions
    : [];
  if (raw.length === 0) throw new Error('That chat message has no reaction offers');

  const resolvers = chatResolvers();
  const offers = parseIncomingReactions(raw, resolvers);
  const offer = selectOffer(offers, params.offer);
  const entry = raw[offer.index];

  if (offer.used) throw new Error(`Offer [${offer.index}] "${offer.label}" was already used`);

  if (params.actor) {
    const wanted = resolveActor(params.actor);
    if (!offer.reactingActor || wanted.uuid !== offer.reactingActor.uuid) {
      throw new Error(
        `Offer [${offer.index}] belongs to ${offer.reactingActor?.name ?? 'another actor'}, not ${wanted.name}`
      );
    }
  }

  const resolverName =
    offer.kind === 'redirectToSelf'
      ? 'resolveRedirectReaction'
      : offer.kind === 'forceReroll'
        ? 'resolveForceRerollReaction'
        : offer.kind === 'spendPoolForDamage'
          ? 'resolveSpendPoolForDamageOffer'
          : null;
  if (!resolverName || typeof message[resolverName] !== 'function') {
    throw new Error(`Offer kind "${offer.kind}" is not supported by this Nimble version`);
  }

  let selection: Record<string, any> | undefined;
  if (offer.kind === 'spendPoolForDamage') selection = buildSpendSelection(entry, params.spend);

  const reactorActor = fromUuidSyncSafe(entry.actorUuid);
  const protector = actorOfToken(entry.tokenUuid) ?? reactorActor;
  const protectedActor = actorOfToken(entry.targetTokenUuid);
  const before = {
    targets: targetsOf(message),
    offers: offerStates(message),
    reactor: actorStateSnapshot(protector),
    ...(protectedActor ? { originalTarget: actorStateSnapshot(protectedActor) } : {}),
  };
  const knownMessageIds = new Set(toList((game as any).messages ?? []).map((m: any) => m.id));

  // Baseline Interpose costs the heroic reaction in a started combat (same as the button).
  let cost: Record<string, any> | null = null;
  if (offer.kind === 'redirectToSelf' && offer.source === 'baseline') {
    const combat = (game as any).combat;
    const combatant = combatantFor(combat, entry.tokenUuid);
    if (combatant && typeof combat.useHeroicReactions === 'function') {
      const costBefore = combatantSnapshot(combatant);
      let paid = await combat.useHeroicReactions(combatant.id, ['interpose']);
      let forced = false;
      if (!paid && params.force === true) {
        paid = await combat.useHeroicReactions(combatant.id, ['interpose'], { force: true });
        forced = true;
      }
      if (!paid) {
        const retryHint =
          params.force === true
            ? 'Even force:true was refused (dead or not allowed to react).'
            : "Pass force:true to confirm anyway, as the card button's confirmation does.";
        throw new Error(
          `${combatant.name} cannot pay for Interpose (the interpose reaction is spent, they lack actions, ` +
            `it is their own turn, or they are down). Nothing was changed. ${retryHint}`
        );
      }
      cost = {
        paid: true,
        forced,
        combatant: combatant.name,
        before: costBefore,
        after: combatantSnapshot(combatant),
      };
    } else {
      cost = {
        paid: false,
        reason: 'No started combat (or no combatant for this token): nothing to spend.',
      };
    }
  }

  const userId = (game as any).user.id;
  if (offer.kind === 'spendPoolForDamage') {
    await message.resolveSpendPoolForDamageOffer(entry.id, userId, selection, false);
  } else {
    await message[resolverName](entry.id, userId, false);
  }
  await settle(300);

  const fresh = (game as any).messages?.get(params.messageId);
  const afterOffers = parseIncomingReactions(fresh?.system?.incomingReactions, resolvers);
  const applied = afterOffers[offer.index]?.used === true;

  const created = toList((game as any).messages ?? [])
    .filter((m: any) => !knownMessageIds.has(m.id))
    .map((m: any) => parseMessage(m, false));

  const result: Record<string, any> = {
    applied,
    messageId: params.messageId,
    offer: { index: offer.index, id: offer.id, kind: offer.kind, label: offer.label },
    reactingActor: offer.reactingActor,
    cost,
    targets: { before: before.targets, after: targetsOf(fresh) },
    offers: { before: before.offers, after: offerStates(fresh) },
    state: {
      reactor: { before: before.reactor, after: actorStateSnapshot(protector) },
      ...(protectedActor
        ? {
            originalTarget: {
              before: before.originalTarget,
              after: actorStateSnapshot(protectedActor),
            },
          }
        : {}),
    },
    newMessages: created,
  };
  if (offer.kind === 'forceReroll' && applied) {
    result.damageAfter = parseMessage(fresh, true).nimble?.effects.filter(
      e => e.amount !== undefined
    );
  }
  if (!applied) {
    const spent = cost?.paid
      ? 'The Interpose action cost had already been spent.'
      : 'Nothing was spent.';
    result.warning =
      'Nimble declined the reaction without an error (it revalidates silently: offer already used, rule disabled or removed, ' +
      `dice no longer in the pool, or the spend no longer applies). ${spent}`;
  }
  return result;
}

/** Build the PoolSpendSelection the card's dice picker would send. */
function buildSpendSelection(entry: any, spend?: { faceIndices: number[] }): Record<string, any> {
  const indices = spend?.faceIndices;
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error(
      'spendPoolForDamage offers need spend.faceIndices: the positions of the dice to spend in the ' +
        "pool's faces (see get-actor-resources dicePools[].faces)."
    );
  }
  const item = fromUuidSyncSafe(entry.itemUuid);
  const rule = item?.system?.rules?.find((r: any) => r.id === entry.ruleId);
  if (!rule) throw new Error('The rule behind this offer no longer exists');
  const actor = fromUuidSyncSafe(entry.actorUuid);
  const poolId =
    rule.poolScope === 'actor' ? `actor:${rule.poolIdentifier}` : String(rule.poolIdentifier);
  const state =
    rule.poolScope === 'actor'
      ? actor?.flags?.nimble?.dicePools?.[poolId]
      : item?.flags?.nimble?.dicePools?.[poolId];
  const faces: number[] = Array.isArray(state?.faces) ? state.faces.map(Number) : [];
  if (faces.length === 0) throw new Error(`Dice pool "${poolId}" is empty or missing`);
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= faces.length) {
      throw new Error(
        `faceIndices contains ${i}; the pool has ${faces.length} dice (0-${faces.length - 1})`
      );
    }
  }
  return { poolId, faceIndices: indices, expectedFaces: indices.map(i => faces[i]) };
}
