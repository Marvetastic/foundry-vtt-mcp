/**
 * Nimble RPG Index Builder
 *
 * Runs in Foundry's browser context to build the enhanced creature index
 * from npc, minion and soloMonster actors.
 */

import type { IndexBuilder, NimbleCreatureIndex } from '../types.js';
import {
  MONSTER_ACTOR_TYPES,
  MOVEMENT_MODES,
  SAVE_KEYS,
  getMonsterRole,
  parseNimbleLevel,
} from './constants.js';

/**
 * Extract the indexed fields from a Nimble actor (document or plain object).
 * Shared by the index builder and the adapter.
 */
export function extractNimbleSystemData(doc: any): NimbleCreatureIndex['systemData'] {
  const system = doc.system ?? {};
  const attributes = system.attributes ?? {};
  const details = system.details ?? {};
  const items: any[] = Array.isArray(doc.items) ? doc.items : (doc.items?.contents ?? []);
  const subtypes = items
    .filter(i => i?.type === 'monsterFeature')
    .map(i => i.system?.subtype as string | undefined);

  const movement: Record<string, number> = {};
  for (const mode of MOVEMENT_MODES) {
    const speed = Number(attributes.movement?.[mode] ?? 0);
    if (speed > 0 || mode === 'walk') movement[mode] = speed;
  }

  const saveRollModes: Record<string, number> = {};
  for (const key of SAVE_KEYS) {
    const mode = Number(system.savingThrows?.[key]?.defaultRollMode ?? 0);
    if (mode !== 0) saveRollModes[key] = mode;
  }

  const levelLabel = details.level !== undefined ? String(details.level) : undefined;
  const role = getMonsterRole(doc.type, details.isFlunky);
  const hp = Number(attributes.hp?.max);

  const data: NimbleCreatureIndex['systemData'] = {
    hasBloodied: subtypes.includes('bloodied'),
    hasLastStand: subtypes.includes('lastStand'),
    featureCount: subtypes.length,
    movement,
    saveRollModes,
  };
  const level = parseNimbleLevel(levelLabel);
  if (level !== undefined) data.level = level;
  if (levelLabel !== undefined) data.levelLabel = levelLabel;
  if (role) data.role = role;
  if (details.creatureType) data.creatureType = details.creatureType;
  if (attributes.sizeCategory) data.size = attributes.sizeCategory;
  if (attributes.armor) data.armor = attributes.armor;
  if (Number.isFinite(hp)) data.hitPoints = hp;
  return data;
}

export class NimbleIndexBuilder implements IndexBuilder {
  private moduleId: string;

  constructor(moduleId: string = 'foundry-mcp-bridge') {
    this.moduleId = moduleId;
  }

  getSystemId() {
    return 'nimble' as const;
  }

  async buildIndex(packs: any[], _force = false): Promise<NimbleCreatureIndex[]> {
    const actorPacks = packs.filter(pack => pack.metadata?.type === 'Actor');
    const creatures: NimbleCreatureIndex[] = [];
    let totalErrors = 0;

    for (const pack of actorPacks) {
      const result = await this.extractDataFromPack(pack);
      creatures.push(...result.creatures);
      totalErrors += result.errors;
    }

    console.log(
      `[${this.moduleId}] Nimble index complete: ${creatures.length} monsters, ${totalErrors} errors`
    );
    return creatures;
  }

  async extractDataFromPack(
    pack: any
  ): Promise<{ creatures: NimbleCreatureIndex[]; errors: number }> {
    const creatures: NimbleCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();
      for (const doc of documents) {
        if (!MONSTER_ACTOR_TYPES.includes(doc.type)) continue;
        try {
          creatures.push({
            id: doc.id,
            name: doc.name,
            type: doc.type,
            packName: pack.collection,
            packLabel: pack.metadata?.label ?? pack.collection,
            img: doc.img,
            system: 'nimble',
            systemData: extractNimbleSystemData(doc),
          });
        } catch (error) {
          console.warn(`[${this.moduleId}] Failed to extract Nimble data from ${doc.name}:`, error);
          errors++;
        }
      }
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to load documents from ${pack.metadata?.label}:`,
        error
      );
      errors++;
    }

    return { creatures, errors };
  }
}
