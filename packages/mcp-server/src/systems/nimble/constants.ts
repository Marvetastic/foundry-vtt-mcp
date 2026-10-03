/**
 * Nimble RPG constants
 *
 * Field paths and enums mirror the Nimble Foundry system's DataModels
 * (NimbleNPCData / NimbleMinionData / NimbleSoloMonsterData and
 * NimbleMonsterFeatureData), verified against system v0.9.0 and its
 * bundled Nimble Monsters / Nimble Legendary Monsters compendiums.
 */

/** Actor types defined by the Nimble system. */
export const ACTOR_TYPES = {
  CHARACTER: 'character',
  NPC: 'npc',
  MINION: 'minion',
  SOLO_MONSTER: 'soloMonster',
} as const;

/** Actor types that are monsters (indexed and handled as stat blocks). */
export const MONSTER_ACTOR_TYPES: readonly string[] = [
  ACTOR_TYPES.NPC,
  ACTOR_TYPES.MINION,
  ACTOR_TYPES.SOLO_MONSTER,
];

/**
 * Encounter role of a monster. Nimble encodes this in the actor type
 * (plus the `details.isFlunky` flag on npc actors), not a separate field.
 */
export const MONSTER_ROLES = ['minion', 'flunky', 'standard', 'solo'] as const;
export type NimbleMonsterRole = (typeof MONSTER_ROLES)[number];

export const ARMOR_TYPES = ['none', 'medium', 'heavy'] as const;
export const SIZE_CATEGORIES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'] as const;
export const SAVE_KEYS = ['strength', 'dexterity', 'intelligence', 'will'] as const;
export const MOVEMENT_MODES = ['walk', 'fly', 'swim', 'climb', 'burrow'] as const;

/** `system.subtype` values for monsterFeature items. */
export const FEATURE_SUBTYPES = [
  'feature',
  'action',
  'attackSequence',
  'bloodied',
  'lastStand',
] as const;

/** Save shorthand aliases accepted by normalizePayload (matches the system's importer). */
export const SAVE_ALIASES: Record<string, (typeof SAVE_KEYS)[number]> = {
  str: 'strength',
  strength: 'strength',
  dex: 'dexterity',
  dexterity: 'dexterity',
  int: 'intelligence',
  intelligence: 'intelligence',
  wil: 'will',
  wis: 'will',
  will: 'will',
};

/**
 * Parse a Nimble level string ("1/4", "1/2", "3") into a number for
 * sorting and range filtering. Returns undefined when unparseable.
 */
export function parseNimbleLevel(level: unknown): number | undefined {
  if (typeof level === 'number') return Number.isFinite(level) ? level : undefined;
  if (typeof level !== 'string') return undefined;
  const trimmed = level.trim();
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(trimmed);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator === 0 ? undefined : Number(fraction[1]) / denominator;
  }
  const value = Number(trimmed);
  return trimmed !== '' && Number.isFinite(value) ? value : undefined;
}

/** Map an actor type + flunky flag to the encounter role. */
export function getMonsterRole(
  actorType: string,
  isFlunky?: boolean
): NimbleMonsterRole | undefined {
  if (actorType === ACTOR_TYPES.MINION) return 'minion';
  if (actorType === ACTOR_TYPES.SOLO_MONSTER) return 'solo';
  if (actorType === ACTOR_TYPES.NPC) return isFlunky ? 'flunky' : 'standard';
  return undefined;
}

/**
 * Describe a saving throw's defaultRollMode (-3..3): positive values roll
 * with that many advantage dice, negative with disadvantage.
 */
export function describeRollMode(mode: number): string {
  if (mode > 0) return mode === 1 ? 'advantage' : `advantage x${mode}`;
  if (mode < 0) return mode === -1 ? 'disadvantage' : `disadvantage x${-mode}`;
  return 'normal';
}
