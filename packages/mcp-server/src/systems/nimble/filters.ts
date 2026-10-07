/**
 * Nimble RPG Filter System
 *
 * Zod schemas and filter matching logic for Nimble monsters.
 */

import { z } from 'zod';
import { ARMOR_TYPES, MONSTER_ROLES, SIZE_CATEGORIES, parseNimbleLevel } from './constants.js';

type Range = number | { min?: number | undefined; max?: number | undefined };

const RangeSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
});

/** Level accepts a number, a Nimble level string ("1/4"), or a range. */
const LevelSchema = z.union([
  z.number(),
  z
    .string()
    .refine(val => parseNimbleLevel(val) !== undefined, { message: 'Invalid Nimble level' })
    .transform(val => parseNimbleLevel(val) as number),
  RangeSchema,
]);

export const NimbleFiltersSchema = z.object({
  level: LevelSchema.optional(),
  role: z.enum(MONSTER_ROLES).optional(),
  /** Case-insensitive substring match — Nimble creature types are free text. */
  creatureType: z.string().optional(),
  size: z.enum(SIZE_CATEGORIES).optional(),
  armor: z.enum(ARMOR_TYPES).optional(),
  hitPoints: z.union([z.number(), RangeSchema]).optional(),
  hasBloodied: z.boolean().optional(),
  hasLastStand: z.boolean().optional(),
  name: z.string().optional(),
});

export type NimbleFilters = z.infer<typeof NimbleFiltersSchema>;

function inRange(value: number | undefined, filter: Range) {
  if (value === undefined) return false;
  if (typeof filter === 'number') return value === filter;
  if (filter.min !== undefined && value < filter.min) return false;
  if (filter.max !== undefined && value > filter.max) return false;
  return true;
}

export function matchesNimbleFilters(creature: any, filters: NimbleFilters): boolean {
  const data = creature.systemData ?? {};

  if (filters.level !== undefined && !inRange(data.level, filters.level)) return false;
  if (filters.role && data.role !== filters.role) return false;
  if (
    filters.creatureType &&
    !String(data.creatureType ?? '')
      .toLowerCase()
      .includes(filters.creatureType.toLowerCase())
  ) {
    return false;
  }
  if (filters.size && data.size !== filters.size) return false;
  if (filters.armor && data.armor !== filters.armor) return false;
  if (filters.hitPoints !== undefined && !inRange(data.hitPoints, filters.hitPoints)) return false;
  if (filters.hasBloodied !== undefined && !!data.hasBloodied !== filters.hasBloodied) return false;
  if (filters.hasLastStand !== undefined && !!data.hasLastStand !== filters.hasLastStand) {
    return false;
  }
  if (filters.name && !creature.name.toLowerCase().includes(filters.name.toLowerCase())) {
    return false;
  }

  return true;
}

function describeRange(label: string, filter: Range): string {
  if (typeof filter === 'number') return `${label} ${filter}`;
  return `${label} ${filter.min ?? 0}-${filter.max ?? '∞'}`;
}

export function describeNimbleFilters(filters: NimbleFilters): string {
  const parts: string[] = [];

  if (filters.level !== undefined) parts.push(describeRange('Level', filters.level));
  if (filters.role) parts.push(filters.role);
  if (filters.creatureType) parts.push(`type contains "${filters.creatureType}"`);
  if (filters.size) parts.push(filters.size);
  if (filters.armor) parts.push(`${filters.armor} armor`);
  if (filters.hitPoints !== undefined) parts.push(describeRange('HP', filters.hitPoints));
  if (filters.hasBloodied !== undefined) {
    parts.push(filters.hasBloodied ? 'has Bloodied' : 'no Bloodied');
  }
  if (filters.hasLastStand !== undefined) {
    parts.push(filters.hasLastStand ? 'has Last Stand' : 'no Last Stand');
  }
  if (filters.name) parts.push(`name contains "${filters.name}"`);

  return parts.length > 0 ? parts.join(', ') : 'no filters';
}
