/**
 * Nimble level-up grant analysis (read-only).
 *
 * Mirrors how the Nimble system (v0.9.0) decides which subclasses its level-up
 * dialog offers and which features it grants, so custom content can be checked
 * without a human levelling a character. Re-check against these functions
 * after a Nimble update (sources are in systems/nimble/nimble-*.js.map):
 *
 * - src/utils/getSubclassChoices.ts  getSubclassChoices(parentClassIdentifier)
 *     World items, then every pack: type === 'subclass' and
 *     system.parentClass === class identifier. The returned `identifier` is
 *     `name.slugify({ strict: true })`, NOT system.identifier.
 * - src/utils/getClassFeatures.ts  buildClassFeatureIndex() + getClassFeaturesFromIndex()
 *     Skips features with system.subclass. Indexes by (class || group) at
 *     gainedAtLevel and every gainedAtLevels entry (deduped by uuid). The
 *     level-up dialog looks up only the class identifier (no groupIdentifiers).
 *     group '' ("ungrouped") or '*-progression' → auto-grant; any other group →
 *     a "choose N" selection group (N from selectionCountByLevel, default 1).
 *     '-progression' features with applicable levelUpOptions become option pickers.
 * - src/utils/buildSubclassFeatureIndex.ts + src/utils/getSubclassFeatures.ts
 *     Needs subclass && class && group; index[class][group][level].
 * - src/view/dialogs/CharacterLevelUpDialogState.svelte.ts
 *     The subclass key used for that lookup is
 *     `selectedSubclass.name.slugify({ strict: true })`. Subclass choice is
 *     only offered when levelling to SUBCLASS_LEVEL (3).
 * - src/documents/item/base.svelte.ts  prepareBaseData()
 *     Overwrites system.identifier with name.slugify({ strict: true }) on every
 *     data prep, so the stored identifier is ignored; the item NAME is what counts.
 *
 * Class identifiers follow the same rule: a class item's identifier is its
 * slugified name.
 */

export const NIMBLE_SUBCLASS_LEVEL = 3;

export type ItemSource = 'world' | 'compendium';

export interface LevelUpSubclassInput {
  uuid: string;
  name: string;
  source: ItemSource;
  pack?: string | null;
  parentClass: string;
  /** system.identifier as stored in the document source (before data prep). */
  storedIdentifier?: string | null;
}

export interface LevelUpFeatureInput {
  uuid: string;
  name: string;
  source: ItemSource;
  pack?: string | null;
  system: {
    class?: string | null;
    group?: string | null;
    subclass?: boolean | string | null;
    gainedAtLevel?: number | null;
    gainedAtLevels?: number[] | null;
    selectionCountByLevel?: Record<string, number> | null;
    levelUpOptions?: Array<{ applyAtLevels?: number[]; selectionGroups?: string[] }> | null;
    activation?: { effects?: any[] | null } | null;
  };
}

export interface LevelUpClassInput {
  uuid: string;
  name: string;
  source: ItemSource;
}

export interface LevelUpAnalysisInput {
  classIdentifier: string;
  subclassIdentifier?: string;
  level: number;
  classes: LevelUpClassInput[];
  subclasses: LevelUpSubclassInput[];
  features: LevelUpFeatureInput[];
}

export interface LevelUpWarning {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  uuid?: string;
  name?: string;
}

interface FeatureRef {
  uuid: string;
  name: string;
  source: ItemSource;
  pack: string | null;
  group: string;
}

export interface LevelUpAnalysis {
  classIdentifier: string;
  level: number;
  subclassChoiceOfferedAtThisLevel: boolean;
  classFound: Array<{ name: string; uuid: string; source: ItemSource }>;
  subclassesOffered: Array<{
    name: string;
    uuid: string;
    source: ItemSource;
    pack: string | null;
    /** The key the dialog uses to look up this subclass's features (slugified name). */
    groupKey: string;
    storedIdentifier: string | null;
  }>;
  classFeatures: {
    autoGrant: FeatureRef[];
    selectionGroups: Array<{ group: string; selectionCount: number; features: FeatureRef[] }>;
    optionFeatures: FeatureRef[];
  };
  subclassFeatures: Array<{
    subclass: string;
    groupKey: string;
    features: FeatureRef[];
  }>;
  warnings: LevelUpWarning[];
}

export type Slugify = (value: string) => string;

/**
 * Fallback for Foundry's `String.prototype.slugify({ strict: true })`
 * (common/primitives/string.mjs), used in tests. Foundry's version also
 * transliterates via CHAR_MAP; diacritics stripping covers the common cases.
 */
export function defaultSlugify(value: string): string {
  let slug = value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  slug = slug.replace(/[\s-]+/g, '-');
  return slug.replace(/[^a-zA-Z0-9-]/g, '');
}

function levelsOf(system: LevelUpFeatureInput['system']): number[] {
  const levels = new Set<number>();
  if (system.gainedAtLevel) levels.add(system.gainedAtLevel);
  for (const lvl of system.gainedAtLevels ?? []) levels.add(lvl);
  return [...levels];
}

function toRef(feature: LevelUpFeatureInput): FeatureRef {
  return {
    uuid: feature.uuid,
    name: feature.name,
    source: feature.source,
    pack: feature.pack ?? null,
    group: feature.system.group || 'ungrouped',
  };
}

function isAutoGrantGroup(group: string): boolean {
  return group === 'ungrouped' || group.endsWith('-progression');
}

function isOptionApplicable(option: { applyAtLevels?: number[] }, level: number): boolean {
  const levels = option.applyAtLevels ?? [];
  return levels.length === 0 || levels.includes(level);
}

/** Walk activation.effects (including nested `on` branches) and collect every effect node. */
function collectEffects(effects: any[] | null | undefined): any[] {
  const out: any[] = [];
  const walk = (list: any[] | null | undefined) => {
    for (const effect of list ?? []) {
      if (!effect || typeof effect !== 'object') continue;
      out.push(effect);
      if (effect.on && typeof effect.on === 'object') {
        for (const branch of Object.values(effect.on)) {
          if (Array.isArray(branch)) walk(branch);
        }
      }
    }
  };
  walk(effects);
  return out;
}

export function analyzeNimbleLevelUp(
  input: LevelUpAnalysisInput,
  slugify: Slugify = defaultSlugify
): LevelUpAnalysis {
  const { classIdentifier, level } = input;
  const warnings: LevelUpWarning[] = [];

  // ── Class ───────────────────────────────────────────────────────────────
  const classFound = input.classes
    .filter(c => slugify(c.name) === classIdentifier)
    .map(c => ({ name: c.name, uuid: c.uuid, source: c.source }));
  if (classFound.length === 0) {
    warnings.push({
      severity: 'warning',
      code: 'class-not-found',
      message:
        `No class item slugifies to "${classIdentifier}". Class identifiers are the slugified ` +
        `class name (e.g. "The Shepherd" → "the-shepherd").`,
    });
  }

  // ── Subclasses (getSubclassChoices) ────────────────────────────────────
  const subclassesOffered = input.subclasses
    .filter(s => s.parentClass === classIdentifier)
    .map(s => ({
      name: s.name,
      uuid: s.uuid,
      source: s.source,
      pack: s.pack ?? null,
      groupKey: slugify(s.name),
      storedIdentifier: s.storedIdentifier ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const sub of subclassesOffered) {
    if (!sub.groupKey) {
      warnings.push({
        severity: 'error',
        code: 'subclass-empty-identifier',
        message: `Subclass "${sub.name}" slugifies to an empty identifier; none of its features can be found.`,
        uuid: sub.uuid,
        name: sub.name,
      });
    }
    if (!sub.storedIdentifier) {
      warnings.push({
        severity: 'info',
        code: 'subclass-stored-identifier-empty',
        message:
          `Subclass "${sub.name}" has an empty stored system.identifier. Harmless: Nimble ` +
          `derives it from the name ("${sub.groupKey}") at runtime.`,
        uuid: sub.uuid,
        name: sub.name,
      });
    } else if (sub.storedIdentifier !== sub.groupKey) {
      warnings.push({
        severity: 'warning',
        code: 'subclass-identifier-mismatch',
        message:
          `Subclass "${sub.name}" stores system.identifier "${sub.storedIdentifier}", but Nimble ` +
          `ignores it and uses the slugified name "${sub.groupKey}". Feature system.group must be ` +
          `"${sub.groupKey}".`,
        uuid: sub.uuid,
        name: sub.name,
      });
    }
  }

  const keyCounts = new Map<string, typeof subclassesOffered>();
  for (const sub of subclassesOffered) {
    const list = keyCounts.get(sub.groupKey) ?? [];
    list.push(sub);
    keyCounts.set(sub.groupKey, list);
  }
  for (const [key, subs] of keyCounts) {
    if (subs.length < 2) continue;
    warnings.push({
      severity: 'warning',
      code: 'duplicate-subclass-identifier',
      message:
        `${subs.length} subclasses of "${classIdentifier}" share identifier "${key}" ` +
        `(${subs.map(s => `${s.name} [${s.source}${s.pack ? `: ${s.pack}` : ''}]`).join(', ')}). ` +
        `The dialog lists each; their features pool under the same key.`,
    });
  }

  const subclassKeys = new Set(subclassesOffered.map(s => s.groupKey));
  const storedIdToKey = new Map<string, string>();
  for (const sub of subclassesOffered) {
    if (sub.storedIdentifier) storedIdToKey.set(sub.storedIdentifier, sub.groupKey);
  }

  // ── Class features (buildClassFeatureIndex + getClassFeaturesFromIndex) ─
  const classLevelFeatures: LevelUpFeatureInput[] = [];
  const seen = new Set<string>();
  for (const feature of input.features) {
    const sys = feature.system;
    if (sys.subclass) continue;
    const key = sys.class || sys.group;
    if (key !== classIdentifier) continue;
    if (!levelsOf(sys).includes(level)) continue;
    if (seen.has(feature.uuid)) continue;
    seen.add(feature.uuid);
    classLevelFeatures.push(feature);
  }

  const autoGrant: FeatureRef[] = [];
  const optionFeatures: FeatureRef[] = [];
  const groups = new Map<string, LevelUpFeatureInput[]>();
  for (const feature of classLevelFeatures) {
    const group = feature.system.group || 'ungrouped';
    const applicable = (feature.system.levelUpOptions ?? []).filter(o =>
      isOptionApplicable(o, level)
    );
    if (group.endsWith('-progression') && applicable.length > 0) {
      optionFeatures.push(toRef(feature));
      continue;
    }
    const list = groups.get(group) ?? [];
    list.push(feature);
    groups.set(group, list);
  }

  const coveredByOptions = new Set<string>();
  for (const ref of optionFeatures) {
    const feature = classLevelFeatures.find(f => f.uuid === ref.uuid);
    for (const opt of feature?.system.levelUpOptions ?? []) {
      if (!isOptionApplicable(opt, level)) continue;
      for (const g of opt.selectionGroups ?? []) coveredByOptions.add(g);
    }
  }

  const selectionGroups: LevelUpAnalysis['classFeatures']['selectionGroups'] = [];
  for (const [group, list] of groups) {
    if (isAutoGrantGroup(group)) {
      autoGrant.push(...list.map(toRef));
    } else if (!coveredByOptions.has(group)) {
      let count = 1;
      for (const f of list) {
        const c = f.system.selectionCountByLevel?.[String(level)];
        if (typeof c === 'number' && Number.isInteger(c) && c > count) count = c;
      }
      selectionGroups.push({ group, selectionCount: count, features: list.map(toRef) });
    }
  }

  // Auto-grant copies with the same name (e.g. a world edit of a compendium
  // feature) are turned into a "keep one or all" choice by the dialog.
  const byName = new Map<string, FeatureRef[]>();
  for (const ref of autoGrant) {
    const key = ref.name.trim().toLowerCase();
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(ref);
    byName.set(key, list);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    warnings.push({
      severity: 'info',
      code: 'duplicate-auto-grant',
      message:
        `"${list[0].name}" is auto-granted from ${list.length} sources ` +
        `(${list.map(r => r.source + (r.pack ? `: ${r.pack}` : '')).join(', ')}); the dialog will ` +
        `ask the player to keep one or all instead of granting it silently.`,
    });
  }

  // ── Subclass features (buildSubclassFeatureIndex + getSubclassFeaturesFromIndex)
  let targetKeys: Array<{ subclass: string; groupKey: string }>;
  if (input.subclassIdentifier) {
    const wanted = input.subclassIdentifier;
    const match =
      subclassesOffered.find(s => s.groupKey === wanted) ??
      subclassesOffered.find(s => s.name === wanted) ??
      subclassesOffered.find(s => s.storedIdentifier === wanted);
    if (match) {
      targetKeys = [{ subclass: match.name, groupKey: match.groupKey }];
      if (match.groupKey !== wanted && match.name !== wanted) {
        warnings.push({
          severity: 'info',
          code: 'subclass-matched-by-stored-identifier',
          message: `"${wanted}" matched subclass "${match.name}" by stored identifier; the dialog uses "${match.groupKey}".`,
        });
      }
    } else {
      targetKeys = [{ subclass: wanted, groupKey: wanted }];
      warnings.push({
        severity: 'error',
        code: 'subclass-not-offered',
        message:
          `No subclass of "${classIdentifier}" matches "${wanted}". The dialog will not offer it. ` +
          `Check that subclass.system.parentClass is "${classIdentifier}".`,
      });
    }
  } else {
    targetKeys = subclassesOffered.map(s => ({ subclass: s.name, groupKey: s.groupKey }));
  }

  const subclassFeatures = targetKeys.map(({ subclass, groupKey }) => {
    const hits: FeatureRef[] = [];
    const seenSub = new Set<string>();
    for (const feature of input.features) {
      const sys = feature.system;
      if (!sys.subclass || !sys.class || !sys.group) continue;
      if (sys.class !== classIdentifier || sys.group !== groupKey) continue;
      if (!levelsOf(sys).includes(level) || seenSub.has(feature.uuid)) continue;
      seenSub.add(feature.uuid);
      hits.push(toRef(feature));
    }
    return { subclass, groupKey, features: hits };
  });

  // ── Per-feature checks (features relevant to this class) ───────────────
  const nameKeys = new Map<string, LevelUpFeatureInput[]>();
  for (const feature of input.features) {
    const sys = feature.system;
    const relevant =
      sys.class === classIdentifier ||
      (!sys.class && sys.group === classIdentifier) ||
      (sys.subclass && sys.group && subclassKeys.has(sys.group));
    if (!relevant) continue;
    const ref = { uuid: feature.uuid, name: feature.name };

    if (sys.subclass) {
      if (!sys.class || !sys.group) {
        warnings.push({
          severity: 'error',
          code: 'subclass-feature-unindexed',
          message:
            `Subclass feature "${feature.name}" needs both system.class and system.group set; ` +
            `Nimble skips it otherwise.`,
          ...ref,
        });
      } else if (!subclassKeys.has(sys.group)) {
        const hint = storedIdToKey.get(sys.group);
        warnings.push({
          severity: 'error',
          code: 'feature-group-no-subclass',
          message:
            `Subclass feature "${feature.name}" has group "${sys.group}", which matches no subclass ` +
            `of "${sys.class}". ${
              hint
                ? `It matches a stored identifier; use the slugified subclass name "${hint}".`
                : `Known subclass keys: ${[...subclassKeys].join(', ') || '(none)'}.`
            }`,
          ...ref,
        });
      }
    }

    const levels = sys.gainedAtLevels ?? [];
    if (sys.gainedAtLevel && levels.length > 0 && !levels.includes(sys.gainedAtLevel)) {
      warnings.push({
        severity: 'warning',
        code: 'gained-at-level-mismatch',
        message:
          `"${feature.name}" has gainedAtLevel ${sys.gainedAtLevel} not in gainedAtLevels ` +
          `[${levels.join(', ')}]. Nimble indexes both, so it is granted at every one of those levels.`,
        ...ref,
      });
    }
    if (!sys.gainedAtLevel && levels.length === 0) {
      warnings.push({
        severity: 'warning',
        code: 'no-gained-level',
        message: `"${feature.name}" has no gainedAtLevel/gainedAtLevels; it is never granted on level-up.`,
        ...ref,
      });
    }

    const effects = collectEffects(sys.activation?.effects);
    const ids = new Map<string, number>();
    for (const effect of effects) {
      const id = effect.id;
      if (typeof id !== 'string' || id.length !== 16) {
        warnings.push({
          severity: 'error',
          code: 'effect-id-invalid',
          message:
            `"${feature.name}" has an activation effect (type "${effect.type ?? '?'}") whose id ` +
            `${JSON.stringify(id ?? null)} is not a 16-character string.`,
          ...ref,
        });
        continue;
      }
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count < 2) continue;
      warnings.push({
        severity: 'error',
        code: 'effect-id-duplicate',
        message: `"${feature.name}" reuses activation effect id "${id}" ${count} times; ids must be unique.`,
        ...ref,
      });
    }

    const nameKey = `${sys.subclass ? 'sub' : 'cls'}:${sys.class ?? ''}:${sys.group ?? ''}:${slugify(feature.name)}`;
    const list = nameKeys.get(nameKey) ?? [];
    list.push(feature);
    nameKeys.set(nameKey, list);
  }

  for (const list of nameKeys.values()) {
    if (list.length < 2) continue;
    warnings.push({
      severity: 'info',
      code: 'duplicate-feature-identifier',
      message:
        `${list.length} features share identifier "${slugify(list[0].name)}" in the same class/group ` +
        `(${list.map(f => `${f.name} [${f.source}${f.pack ? `: ${f.pack}` : ''}]`).join(', ')}).`,
    });
  }

  if (level !== NIMBLE_SUBCLASS_LEVEL && subclassesOffered.length > 0) {
    warnings.push({
      severity: 'info',
      code: 'subclass-choice-level',
      message: `The dialog only offers a subclass choice when levelling to ${NIMBLE_SUBCLASS_LEVEL}; at other levels it uses the subclass already on the character.`,
    });
  }

  return {
    classIdentifier,
    level,
    subclassChoiceOfferedAtThisLevel: level === NIMBLE_SUBCLASS_LEVEL,
    classFound,
    subclassesOffered,
    classFeatures: { autoGrant, selectionGroups, optionFeatures },
    subclassFeatures,
    warnings,
  };
}
