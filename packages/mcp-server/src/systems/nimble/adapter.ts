/**
 * Nimble RPG System Adapter
 *
 * Implements SystemAdapter for the Nimble Foundry system (id: "nimble").
 *
 * Monsters are npc / minion / soloMonster actors with string levels
 * ("1/4", "3"), armor none|medium|heavy, and their abilities stored as
 * embedded monsterFeature items (subtypes feature, action, attackSequence,
 * bloodied, lastStand).
 */

import type {
  SystemAdapter,
  SystemMetadata,
  SystemCreatureIndex,
  NimbleCreatureIndex,
} from '../types.js';
import { NimbleFiltersSchema, matchesNimbleFilters, describeNimbleFilters } from './filters.js';
import {
  MONSTER_ACTOR_TYPES,
  MOVEMENT_MODES,
  SAVE_ALIASES,
  SAVE_KEYS,
  describeRollMode,
  getMonsterRole,
} from './constants.js';

/** Top-level damage trait keys (full and short) that belong under system.attributes. */
const DAMAGE_TRAIT_ALIASES: Array<[string, string]> = [
  ['damageResistances', 'damageResistances'],
  ['damageImmunities', 'damageImmunities'],
  ['damageVulnerabilities', 'damageVulnerabilities'],
  ['resistances', 'damageResistances'],
  ['immunities', 'damageImmunities'],
  ['vulnerabilities', 'damageVulnerabilities'],
];

function stripHtml(html: unknown): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Summarise a monsterFeature item's damage/save/condition effects into a short string. */
function summarizeEffects(effects: any[]): string[] {
  const parts: string[] = [];
  const walk = (list: any[]) => {
    for (const e of list ?? []) {
      if (e?.type === 'damage' && e.formula)
        parts.push(`${e.formula} ${e.damageType ?? ''}`.trim());
      else if (e?.type === 'healing' && e.formula) parts.push(`heal ${e.formula}`);
      else if (e?.type === 'savingThrow') {
        parts.push(`${e.saveType ?? ''} save${e.saveDC ? ` DC ${e.saveDC}` : ''}`.trim());
      } else if (e?.type === 'condition' && e.condition) parts.push(e.condition);
      if (e?.on && typeof e.on === 'object') {
        for (const branch of Object.values(e.on)) walk(branch as any[]);
      }
    }
  };
  walk(effects);
  return parts;
}

export class NimbleAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'nimble',
      name: 'nimble',
      displayName: 'Nimble RPG',
      version: '1.0.0',
      description:
        'Support for Nimble RPG monsters: npc/minion/soloMonster actors, string levels, ' +
        'armor tiers, save roll modes, and monsterFeature actions (attack sequences, ' +
        'Bloodied, Last Stand).',
      supportedFeatures: {
        creatureIndex: true,
        characterStats: true,
        spellcasting: false,
        powerLevel: true,
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'nimble';
  }

  extractCreatureData(
    _doc: any,
    _pack: any
  ): { creature: SystemCreatureIndex; errors: number } | null {
    throw new Error('extractCreatureData should be called from NimbleIndexBuilder');
  }

  getFilterSchema() {
    return NimbleFiltersSchema;
  }

  matchesFilters(creature: SystemCreatureIndex, filters: Record<string, any>): boolean {
    const validated = NimbleFiltersSchema.safeParse(filters);
    if (!validated.success) return false;
    return matchesNimbleFilters(creature, validated.data);
  }

  getDataPaths(): Record<string, string | null> {
    return {
      level: 'system.details.level',
      creatureType: 'system.details.creatureType',
      isFlunky: 'system.details.isFlunky',
      size: 'system.attributes.sizeCategory',
      armor: 'system.attributes.armor',
      hitPoints: 'system.attributes.hp',
      movement: 'system.attributes.movement',
      damageResistances: 'system.attributes.damageResistances',
      damageImmunities: 'system.attributes.damageImmunities',
      damageVulnerabilities: 'system.attributes.damageVulnerabilities',
      saves: 'system.savingThrows',
      attackSequence: 'system.attackSequence',
      description: 'system.description',

      challengeRating: null,
      armorClass: null,
      alignment: null,
      rarity: null,
      traits: null,
      spells: null,
      legendaryActions: null,
    };
  }

  formatCreatureForList(creature: SystemCreatureIndex): any {
    const data = (creature as NimbleCreatureIndex).systemData ?? {};
    const formatted: any = {
      id: creature.id,
      name: creature.name,
      type: creature.type,
      pack: { id: creature.packName, label: creature.packLabel },
      stats: {
        level: data.levelLabel,
        role: data.role,
        creatureType: data.creatureType,
        size: data.size,
        armor: data.armor,
        hitPoints: data.hitPoints,
      },
    };
    if (creature.img) formatted.hasImage = true;
    return formatted;
  }

  formatCreatureForDetails(creature: SystemCreatureIndex): any {
    const formatted = this.formatCreatureForList(creature);
    formatted.detailedStats = (creature as NimbleCreatureIndex).systemData;
    if (creature.img) formatted.img = creature.img;
    return formatted;
  }

  describeFilters(filters: Record<string, any>): string {
    const validated = NimbleFiltersSchema.safeParse(filters);
    if (!validated.success) return 'invalid filters';
    return describeNimbleFilters(validated.data);
  }

  getPowerLevel(creature: SystemCreatureIndex): number | undefined {
    return (creature as NimbleCreatureIndex).systemData?.level;
  }

  extractCharacterStats(actorData: any): any {
    const system = actorData.system || {};
    const attributes = system.attributes || {};
    const stats: any = { name: actorData.name, type: actorData.type };

    if (MONSTER_ACTOR_TYPES.includes(actorData.type)) {
      stats.level = system.details?.level;
      stats.role = getMonsterRole(actorData.type, system.details?.isFlunky);
      if (system.details?.creatureType) stats.creatureType = system.details.creatureType;
      stats.size = attributes.sizeCategory;
      stats.armor = attributes.armor;
    }

    if (attributes.hp) {
      stats.hitPoints = {
        current: attributes.hp.value ?? 0,
        max: attributes.hp.max ?? 0,
        temp: attributes.hp.temp ?? 0,
      };
    }
    if (attributes.wounds) {
      stats.wounds = { value: attributes.wounds.value ?? 0, max: attributes.wounds.max };
    }

    if (attributes.movement) {
      const movement: Record<string, number> = {};
      for (const mode of MOVEMENT_MODES) {
        const speed = Number(attributes.movement[mode] ?? 0);
        if (speed > 0) movement[mode] = speed;
      }
      stats.movement = movement;
    }

    for (const key of ['damageResistances', 'damageImmunities', 'damageVulnerabilities']) {
      if (Array.isArray(attributes[key]) && attributes[key].length > 0) {
        stats[key] = attributes[key];
      }
    }

    if (system.savingThrows) {
      stats.saves = {};
      for (const key of SAVE_KEYS) {
        const save = system.savingThrows[key];
        if (!save) continue;
        const mode = Number(save.defaultRollMode ?? 0);
        stats.saves[key] = {
          mod: (save.mod ?? 0) + (save.bonus ?? 0),
          rollMode: mode,
          ...(mode !== 0 ? { rollModeLabel: describeRollMode(mode) } : {}),
        };
      }
    }

    if (system.abilities) {
      stats.abilities = {};
      for (const [key, ability] of Object.entries<any>(system.abilities)) {
        stats.abilities[key] = ability?.mod ?? ability?.baseValue ?? ability;
      }
    }

    const attackSequence = stripHtml(system.attackSequence);
    if (attackSequence) stats.attackSequenceNotes = attackSequence;

    // Monster features: grouped by subtype with effect summaries so a stat
    // block can be read at a glance without fetching every item.
    const items: any[] = Array.isArray(actorData.items) ? actorData.items : [];
    const features = items.filter(i => i?.type === 'monsterFeature');
    if (features.length > 0) {
      stats.features = features.map(item => {
        const activation = item.system?.activation ?? {};
        const entry: any = {
          id: item.id ?? item._id,
          name: item.name,
          subtype: item.system?.subtype ?? 'feature',
        };
        const effects = summarizeEffects(activation.effects ?? []);
        if (effects.length > 0) entry.effects = effects;
        if (item.system?.parentItemId) entry.parentItemId = item.system.parentItemId;
        if (item.system?.lastStandHp) entry.lastStandHp = item.system.lastStandHp;
        const description = stripHtml(item.system?.description);
        if (description) entry.description = description;
        return entry;
      });
    }

    return stats;
  }

  extractBasicInfo(actorData: any): any {
    const system = actorData.system || {};
    const attributes = system.attributes || {};
    const basicInfo: any = { actorType: actorData.type };

    if (attributes.hp) {
      basicInfo.hitPoints = {
        current: attributes.hp.value ?? 0,
        max: attributes.hp.max ?? 0,
        temp: attributes.hp.temp ?? 0,
      };
    }

    if (MONSTER_ACTOR_TYPES.includes(actorData.type)) {
      if (system.details?.level !== undefined) basicInfo.level = system.details.level;
      basicInfo.role = getMonsterRole(actorData.type, system.details?.isFlunky);
      if (system.details?.creatureType) basicInfo.creatureType = system.details.creatureType;
      if (attributes.sizeCategory) basicInfo.size = attributes.sizeCategory;
      if (attributes.armor) basicInfo.armor = attributes.armor;
    }

    const description = stripHtml(system.description);
    if (description) basicInfo.description = description;
    return basicInfo;
  }

  describeActorSchema(): string {
    return [
      '=== Nimble Actor Schema Reference ===',
      '',
      'ACTOR TYPES: character, npc, minion, soloMonster',
      '  npc         standard monster (set details.isFlunky:true for a flunky)',
      '  minion      dies in one hit, no crits; HP is 1 by default',
      '  soloMonster legendary/boss monster; uses Bloodied and Last Stand features',
      '',
      'MONSTER SYSTEM FIELDS (npc / minion / soloMonster):',
      '  details.level         STRING: "1/4", "1/3", "1/2", "1" ... "20"',
      '  details.creatureType  free text, e.g. "Goblins", "Undead", "Floral Dragon"',
      '  details.isFlunky      boolean (npc only)',
      '  attributes.hp         { max, value, temp }  (set max AND value on create)',
      '  attributes.armor      "none" | "medium" | "heavy"',
      '  attributes.sizeCategory  tiny|small|medium|large|huge|gargantuan',
      '  attributes.movement   { walk:6, fly:0, swim:0, climb:0, burrow:0 }  (spaces)',
      '  attributes.damageResistances / damageImmunities / damageVulnerabilities  string[]',
      '  savingThrows.<strength|dexterity|intelligence|will>.defaultRollMode',
      '                        -3..3 (1 = advantage, -1 = disadvantage)',
      '  attackSequence        HTML notes for the attack sequence',
      '  description           HTML',
      '',
      'SHORTHANDS accepted by create/update (normalized automatically):',
      '  level:3 | "1/4"       -> details.level (stringified)',
      '  creatureType:"Goblins" -> details.creatureType',
      '  hp:30                 -> attributes.hp {max:30, value:30}',
      '  armor:"Heavy", size:"Large" -> attributes.armor / attributes.sizeCategory (lowercased)',
      '  speed:8 / movement:{fly:6} -> attributes.movement',
      '  saves:{str:1, wil:-1} -> savingThrows.*.defaultRollMode',
      '  immunities/resistances/vulnerabilities:["fire"] (or damageImmunities etc.)',
      '                        -> attributes.damageImmunities / ...',
      '  Prototype token size is set from attributes.sizeCategory on create.',
      '',
      'MONSTER ABILITIES are embedded Items of type "monsterFeature". Add them with',
      'manage-world-items action "add-to-actor". Item system fields:',
      '  subtype      "feature" | "action" | "attackSequence" | "bloodied" | "lastStand"',
      '  description  HTML shown on the sheet (e.g. "<p>1d6+2. On hit: Dazed.</p>")',
      '  parentItemId _id of an attackSequence item, for actions chosen from that sequence',
      '  lastStandHp  HP the monster resets to at Last Stand (lastStand subtype only)',
      '  activation.duration.type "action" for actions, "none" for passives',
      '  activation.targets { count, attackType:""|"reach"|"range", distance }',
      '  activation.effects  rollable effects, e.g. a damage effect:',
      '    { id, type:"damage", damageType:"piercing", formula:"1d6+2", canCrit:true, canMiss:true,',
      '      parentContext:null, parentNode:null,',
      '      on:{ hit:[ { id, type:"damageOutcome", outcome:"fullDamage",',
      '                   parentContext:"hit", parentNode:<damage id> } ] } }',
      '    Conditions on hit: { id, type:"condition", condition:"dazed", parentContext:"hit", parentNode:<damage id> }',
      '    Valid conditions: blinded, charged, charmed, confused, dazed, despair, distracted,',
      '    frightened, grappled, hampered, incapacitated, invisible, marked, paralyzed, petrified,',
      '    poisoned, prone, restrained, silenced, slowed, smoldering (fire), stunned, taunted, unconscious',
      '  Saving throw effect: { id, type:"savingThrow", saveType:"dexterity", saveDC:"12",',
      '    parentContext:null, parentNode:null, on:{ failedSave:[ <condition/damage effects> ] } }',
      '  Every effect id must be a unique 16-character string.',
      '',
      'CONVENTIONS from the bundled bestiary:',
      '  Feature/action names end with a period ("Stab.", "Pack Tactics.").',
      '  Solo monsters: one attackSequence item, actions with parentItemId pointing to it,',
      '  plus one "Bloodied" and one "Last Stand" item (lastStandHp > 0).',
      '  Minion damage effects use canCrit:false.',
    ].join('\n');
  }

  /**
   * Expand Nimble shorthands into real DataModel paths. Only keys that are
   * not part of the Nimble schema at the top level are rewritten, so full
   * payloads pass through unchanged.
   */
  normalizePayload(system: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { ...system };
    const attributes: Record<string, any> = { ...(out.attributes ?? {}) };
    const details: Record<string, any> = { ...(out.details ?? {}) };

    const take = (key: string) => {
      const value = out[key];
      delete out[key];
      return value;
    };

    if (out.level !== undefined) details.level = take('level');
    if (out.creatureType !== undefined) details.creatureType = take('creatureType');
    if (out.isFlunky !== undefined) details.isFlunky = take('isFlunky');
    if (out.hp !== undefined) attributes.hp = take('hp');
    if (out.armor !== undefined) attributes.armor = take('armor');
    if (out.size !== undefined) attributes.sizeCategory = take('size');
    if (out.sizeCategory !== undefined) attributes.sizeCategory = take('sizeCategory');
    if (out.speed !== undefined) {
      attributes.movement = { ...(attributes.movement ?? {}), walk: take('speed') };
    }
    if (out.movement !== undefined) {
      attributes.movement = { ...(attributes.movement ?? {}), ...take('movement') };
    }
    for (const [alias, key] of DAMAGE_TRAIT_ALIASES) {
      if (out[alias] !== undefined) attributes[key] = take(alias);
    }

    if (details.level !== undefined) details.level = String(details.level);
    if (typeof attributes.hp === 'number') {
      attributes.hp = { max: attributes.hp, value: attributes.hp, temp: 0 };
    }
    if (typeof attributes.armor === 'string') attributes.armor = attributes.armor.toLowerCase();
    if (typeof attributes.sizeCategory === 'string') {
      attributes.sizeCategory = attributes.sizeCategory.toLowerCase();
    }

    const saveInput = out.saves ?? out.savingThrows;
    delete out.saves;
    if (saveInput && typeof saveInput === 'object') {
      const savingThrows: Record<string, any> = {};
      for (const [key, value] of Object.entries<any>(saveInput)) {
        const saveKey = SAVE_ALIASES[key.toLowerCase()] ?? key;
        savingThrows[saveKey] = typeof value === 'number' ? { defaultRollMode: value } : value;
      }
      out.savingThrows = savingThrows;
    }

    if (Object.keys(attributes).length > 0) out.attributes = attributes;
    if (Object.keys(details).length > 0) out.details = details;
    return out;
  }
}
