/**
 * Chat log parsing (read-only, no Foundry globals).
 *
 * Turns ChatMessage source data into a compact shape for the read-chat-log
 * tool and for use-item's auto-roll result. Works for any system; Nimble
 * activation cards get extra detail. Where Nimble (v0.9.0) keeps card data,
 * per the system source (nimble-*.js.map):
 *
 * - documents/item/base.svelte.ts  activate(): the card's `system` holds
 *   actorName, actorType, activation (the item's activation with each
 *   damage/healing node's evaluated roll at `node.roll` = roll.toJSON()),
 *   isCritical, isMiss, rollMode (advantage count), targets (token UUIDs);
 *   `flags.nimble` holds itemId, itemUuid, actorId, tokenUuid.
 * - dice/DamageRoll.ts  toJSON(): adds isCritical, isMiss, critCount,
 *   originalFormula to the core roll JSON.
 * - documents/chatMessage.ts  effectNodes: which nodes apply depends on the
 *   outcome — crit → ['criticalHit', 'hit'], miss → ['miss'], else ['hit'];
 *   applyHealing() records each applied healing node in system.appliedHealing.
 *   Applying damage is not recorded on the card.
 */

export interface ChatMessageSource {
  _id?: string;
  id?: string;
  timestamp?: number;
  type?: string;
  author?: string | null;
  speaker?: {
    actor?: string | null;
    token?: string | null;
    alias?: string | null;
    scene?: string | null;
  };
  flavor?: string | null;
  content?: string | null;
  whisper?: string[];
  blind?: boolean;
  rolls?: Array<string | Record<string, any>>;
  flags?: Record<string, any>;
  system?: Record<string, any>;
}

export interface ChatLogResolvers {
  actorName?: (actorId: string) => string | null | undefined;
  tokenName?: (tokenUuidOrId: string) => string | null | undefined;
  itemName?: (itemUuid: string) => string | null | undefined;
  userName?: (userId: string) => string | null | undefined;
}

export interface RollSummary {
  formula: string;
  total: number | null;
  dice: Array<{
    faces: number;
    results: Array<{ result: number; active: boolean; exploded?: boolean }>;
  }>;
  isCritical?: boolean;
  isMiss?: boolean;
}

export interface EffectSummary {
  id: string | null;
  type: string;
  /** Outcome branch the node belongs to (hit, miss, criticalHit, failedSave...), null for top level. */
  context: string | null;
  /** Whether the node applies given the card's crit/miss outcome. */
  applies: boolean;
  damageType?: string;
  healingType?: string;
  outcome?: string;
  condition?: string;
  saveType?: string;
  saveDC?: string | number;
  text?: string;
  /** Damage/healing the card would apply before per-target armor/resistance. */
  amount?: number;
  roll?: RollSummary;
}

export interface ParsedChatMessage {
  id: string;
  timestamp: number | null;
  type: string | null;
  author: string | null;
  speaker: {
    alias: string | null;
    actorId: string | null;
    actorName: string | null;
    tokenId: string | null;
    tokenName: string | null;
  };
  flavor: string;
  content: string;
  whispered: boolean;
  whisperTo: string[];
  blind: boolean;
  item: { uuid: string | null; id: string | null; name: string | null } | null;
  rolls?: RollSummary[];
  nimble?: {
    isCritical: boolean;
    isMiss: boolean;
    advantage: number;
    targets: Array<{ uuid: string; name: string | null }>;
    effects: EffectSummary[];
    healingApplied: Array<{
      effectId: string;
      healingType: string;
      amount: number;
      targets: Array<{
        uuid: string;
        tokenName: string;
        previousHp: number;
        newHp: number;
        previousTempHp: number;
        newTempHp: number;
      }>;
    }>;
  };
}

/** Strip HTML tags and collapse whitespace. */
export function htmlToText(html: unknown): string {
  return String(html ?? '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function parseRollData(raw: unknown): Record<string, any> | null {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, any>) : null;
}

/** Summarise a serialized Roll (core or Nimble DamageRoll). */
export function summarizeRoll(raw: unknown): RollSummary | null {
  const roll = parseRollData(raw);
  if (!roll) return null;

  const dice: RollSummary['dice'] = [];
  const walk = (terms: unknown) => {
    if (!Array.isArray(terms)) return;
    for (const term of terms) {
      if (!term || typeof term !== 'object') continue;
      const t = term as Record<string, any>;
      if (typeof t.faces === 'number' && Array.isArray(t.results)) {
        dice.push({
          faces: t.faces,
          results: t.results.map((r: any) => ({
            result: Number(r.result),
            active: r.active !== false && r.discarded !== true,
            ...(r.exploded ? { exploded: true } : {}),
          })),
        });
      }
      walk(t.terms);
      if (Array.isArray(t.rolls)) for (const inner of t.rolls) walk(parseRollData(inner)?.terms);
      if (t.roll) walk(parseRollData(t.roll)?.terms);
    }
  };
  walk(roll.terms);

  const summary: RollSummary = {
    formula: String(roll.formula ?? roll.originalFormula ?? ''),
    total: typeof roll.total === 'number' ? roll.total : null,
    dice,
  };
  if (typeof roll.isCritical === 'boolean') summary.isCritical = roll.isCritical;
  if (typeof roll.isMiss === 'boolean') summary.isMiss = roll.isMiss;
  return summary;
}

/** Outcome contexts that apply for a card, mirroring NimbleChatMessage#effectNodes. */
export function activeContexts(isCritical: boolean, isMiss: boolean): string[] {
  if (isCritical) return ['criticalHit', 'hit'];
  if (isMiss) return ['miss'];
  return ['hit'];
}

/** Flatten a Nimble activation effect tree into summaries. */
export function summarizeEffects(
  effects: unknown,
  isCritical: boolean,
  isMiss: boolean
): EffectSummary[] {
  const contexts = activeContexts(isCritical, isMiss);
  const out: EffectSummary[] = [];

  const walk = (list: unknown, parentApplies: boolean) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, any>;
      const context: string | null = n.parentContext ?? null;
      // Top-level nodes always apply; branches only under the resolved outcome
      // (save branches like failedSave depend on each target's save, so they
      // are reported as applicable and left for the reader to interpret).
      const isOutcomeBranch = context === 'hit' || context === 'miss' || context === 'criticalHit';
      const applies = parentApplies && (!isOutcomeBranch || contexts.includes(context));

      const summary: EffectSummary = {
        id: n.id ?? null,
        type: String(n.type ?? 'unknown'),
        context,
        applies,
      };
      if (n.damageType) summary.damageType = n.damageType;
      if (n.healingType) summary.healingType = n.healingType;
      if (n.outcome) summary.outcome = n.outcome;
      if (n.condition) summary.condition = n.condition;
      if (n.saveType) summary.saveType = n.saveType;
      if (n.saveDC !== undefined && n.saveDC !== '') summary.saveDC = n.saveDC;
      if (n.text) summary.text = htmlToText(n.text);
      const roll = n.roll ? summarizeRoll(n.roll) : null;
      if (roll) summary.roll = roll;

      // Damage amount as the card's Apply Damage button computes it
      // (NimbleChatMessage#collectApplicableDamageRolls): the outcome comes from
      // an active damageOutcome child, else fullDamage on a hit / noDamage on a
      // miss; halfDamage rounds up. Armor and resistances are per target.
      const total = roll?.total ?? null;
      if (n.type === 'damage' && total !== null) {
        let outcome: string = isMiss ? 'noDamage' : 'fullDamage';
        for (const ctx of contexts) {
          const branch = n.on?.[ctx];
          const child = Array.isArray(branch)
            ? branch.find((c: any) => c?.type === 'damageOutcome')
            : undefined;
          if (child?.outcome) {
            outcome = child.outcome;
            break;
          }
        }
        summary.outcome = outcome;
        summary.amount = !applies
          ? 0
          : outcome === 'noDamage'
            ? 0
            : outcome === 'halfDamage'
              ? Math.ceil(total * 0.5)
              : total;
      } else if (n.type === 'healing' && total !== null) {
        summary.amount = applies ? total : 0;
      }
      out.push(summary);

      if (n.on && typeof n.on === 'object') {
        for (const branch of Object.values(n.on)) walk(branch, applies);
      }
    }
  };
  walk(effects, true);
  return out;
}

export function parseChatMessage(
  message: ChatMessageSource,
  options: { includeRolls?: boolean; resolvers?: ChatLogResolvers } = {}
): ParsedChatMessage {
  const { includeRolls = true, resolvers = {} } = options;
  const speaker = message.speaker ?? {};
  const flags = message.flags ?? {};
  const system = message.system ?? {};
  const nimbleFlags = (flags.nimble ?? {}) as Record<string, any>;

  const itemUuid: string | null =
    nimbleFlags.itemUuid ?? flags.dnd5e?.item?.uuid ?? flags.core?.sourceId ?? null;
  const itemId: string | null = nimbleFlags.itemId ?? flags.dnd5e?.item?.id ?? null;
  const item =
    itemUuid || itemId
      ? {
          uuid: itemUuid,
          id: itemId,
          name: (itemUuid && resolvers.itemName?.(itemUuid)) || null,
        }
      : null;

  const whisper = Array.isArray(message.whisper) ? message.whisper : [];

  const parsed: ParsedChatMessage = {
    id: String(message.id ?? message._id ?? ''),
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : null,
    type: message.type ?? null,
    author: (message.author && (resolvers.userName?.(message.author) ?? message.author)) || null,
    speaker: {
      alias: speaker.alias ?? null,
      actorId: speaker.actor ?? null,
      actorName: (speaker.actor && resolvers.actorName?.(speaker.actor)) || speaker.alias || null,
      tokenId: speaker.token ?? null,
      tokenName: (speaker.token && resolvers.tokenName?.(speaker.token)) || null,
    },
    flavor: htmlToText(message.flavor),
    content: htmlToText(message.content),
    whispered: whisper.length > 0,
    whisperTo: whisper.map(id => resolvers.userName?.(id) ?? id),
    blind: message.blind === true,
    item,
  };

  if (includeRolls) {
    parsed.rolls = (message.rolls ?? [])
      .map(r => summarizeRoll(r))
      .filter((r): r is RollSummary => r !== null);
  }

  // Nimble activation card
  if (system && (system.activation || Array.isArray(system.targets))) {
    const isCritical = system.isCritical === true;
    const isMiss = system.isMiss === true;
    const allEffects = summarizeEffects(system.activation?.effects, isCritical, isMiss);
    const effects = includeRolls ? allEffects : allEffects.map(({ roll: _roll, ...rest }) => rest);
    parsed.nimble = {
      isCritical,
      isMiss,
      advantage: Number(system.rollMode ?? 0),
      targets: (Array.isArray(system.targets) ? system.targets : []).map((uuid: string) => ({
        uuid,
        name: resolvers.tokenName?.(uuid) ?? null,
      })),
      effects: effects as EffectSummary[],
      healingApplied: Object.values((system.appliedHealing ?? {}) as Record<string, any>).map(
        (record: any) => ({
          effectId: record.effectId,
          healingType: record.healingType,
          amount: record.amount,
          targets: Array.isArray(record.targets) ? record.targets : [],
        })
      ),
    };
    if (!parsed.item && nimbleFlags.itemUuid) {
      parsed.item = { uuid: nimbleFlags.itemUuid, id: nimbleFlags.itemId ?? null, name: null };
    }
  }

  return parsed;
}

export interface ChatLogQuery {
  limit?: number;
  sinceMessageId?: string;
  sinceTimestamp?: number;
  speaker?: string;
}

/**
 * Select messages (chronological input) per the query and return the last
 * `limit` of them, oldest first. `speakerMatches` decides the speaker filter.
 */
export function selectChatMessages<T extends ChatMessageSource>(
  messages: T[],
  query: ChatLogQuery,
  speakerMatches: (message: T, speaker: string) => boolean
): T[] {
  let selected = messages;
  if (query.sinceMessageId) {
    const index = selected.findIndex(m => (m.id ?? m._id) === query.sinceMessageId);
    if (index === -1) throw new Error(`Chat message not found: ${query.sinceMessageId}`);
    selected = selected.slice(index + 1);
  }
  if (query.sinceTimestamp !== undefined) {
    const since = query.sinceTimestamp;
    selected = selected.filter(m => (m.timestamp ?? 0) > since);
  }
  if (query.speaker) {
    const speaker = query.speaker;
    selected = selected.filter(m => speakerMatches(m, speaker));
  }
  const limit = query.limit ?? 20;
  return selected.slice(Math.max(0, selected.length - limit));
}
