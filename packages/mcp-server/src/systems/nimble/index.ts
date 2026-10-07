/**
 * Nimble RPG System Module
 *
 * Exports for Nimble system support in the Registry Pattern architecture.
 */

export type { NimbleCreatureIndex } from '../types.js';

// Index builder (runs in Foundry browser context)
export { NimbleIndexBuilder, extractNimbleSystemData } from './index-builder.js';

// System adapter (runs in MCP server Node.js context)
export { NimbleAdapter } from './adapter.js';

// Filter system
export { NimbleFiltersSchema, matchesNimbleFilters, describeNimbleFilters } from './filters.js';
export type { NimbleFilters } from './filters.js';

// Constants
export {
  ACTOR_TYPES,
  MONSTER_ACTOR_TYPES,
  MONSTER_ROLES,
  ARMOR_TYPES,
  SIZE_CATEGORIES,
  SAVE_KEYS,
  FEATURE_SUBTYPES,
  parseNimbleLevel,
  getMonsterRole,
} from './constants.js';
