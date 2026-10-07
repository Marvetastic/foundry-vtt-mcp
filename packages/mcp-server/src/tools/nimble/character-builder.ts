/**
 * Nimble: build-nimble-character
 *
 * Builds a test hero at a level. Nimble's own creation and level-up only run
 * through dialogs, so the browser side (data-access.buildNimbleCharacter)
 * mirrors their data writes and grants features with the system's
 * NimbleCharacter#grantLevelUpFeatures; the result is flagged mode:"fallback".
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface NimbleCharacterBuilderToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const ABILITIES = ['strength', 'dexterity', 'intelligence', 'will'] as const;

const schema = z
  .object({
    name: z.string().min(1, 'name is required'),
    folder: z.string().min(1).default('AI Test'),
    ancestry: z.string().min(1, 'ancestry is required'),
    background: z.string().min(1, 'background is required'),
    className: z.string().min(1, 'className is required'),
    subclass: z.string().min(1).optional(),
    level: z.number().int().min(1).max(20),
    abilities: z.record(z.enum(ABILITIES), z.number().int().min(-5).max(12)).optional(),
    statArray: z.enum(['standard', 'balanced', 'minMax']).optional(),
    abilityOrder: z.array(z.enum(ABILITIES)).length(4).optional(),
    startingEquipment: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.abilities && v.statArray) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use either abilities or statArray (+ abilityOrder), not both',
      });
    }
    if (v.abilityOrder && !v.statArray) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'abilityOrder needs statArray' });
    }
    if (v.abilityOrder && new Set(v.abilityOrder).size !== 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'abilityOrder must list each ability once',
      });
    }
    if (v.subclass && v.level < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Subclasses are chosen at level 3; raise level or omit subclass',
      });
    }
  });

export class NimbleCharacterBuilderTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: NimbleCharacterBuilderToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'NimbleCharacterBuilderTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'build-nimble-character',
        description:
          'Nimble only (GM): create a test hero at a level for combat testing. Ancestry, background, class and ' +
          'subclass are found by name, id or uuid in world items first, then compendiums (compendiums are only ' +
          "read). Level 1 gets the class's level-1 features; each further level takes average HP and the " +
          'features check-level-up-grants reports (choices auto-pick the first options), with the subclass at ' +
          'level 3. Max HP and mana are derived by Nimble. Returns mode:"fallback" because Nimble\'s creation ' +
          'and level-up dialogs cannot be driven directly; "notApplied" lists what a real build would add ' +
          '(spells, ASIs, skills). Returns the full item list and stats.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            folder: { type: 'string', description: 'Actor folder (default "AI Test").' },
            ancestry: { type: 'string' },
            background: { type: 'string' },
            className: { type: 'string', description: 'Class name or identifier.' },
            subclass: {
              type: 'string',
              description: 'Subclass name, identifier or uuid (level 3+).',
            },
            level: { type: 'integer', minimum: 1, maximum: 20 },
            abilities: {
              type: 'object',
              description:
                'Ability baseValues, e.g. {"strength":2,"dexterity":2,"intelligence":0,"will":-1}.',
              properties: Object.fromEntries(ABILITIES.map(a => [a, { type: 'integer' }])),
            },
            statArray: {
              type: 'string',
              enum: ['standard', 'balanced', 'minMax'],
              description:
                'Nimble stat array (standard [2,2,0,-1], balanced [2,1,1,0], minMax [3,1,-1,-1]).',
            },
            abilityOrder: {
              type: 'array',
              items: { type: 'string', enum: [...ABILITIES] },
              description: 'With statArray: which ability gets each array value, in order.',
            },
            startingEquipment: {
              type: 'boolean',
              description: "Grant and equip the origins' starting equipment (default true).",
            },
          },
          required: ['name', 'ancestry', 'background', 'className', 'level'],
        },
      },
    ];
  }

  async handleBuildCharacter(args: any): Promise<any> {
    const params = schema.parse(args);
    this.logger.info('Building Nimble character', { name: params.name, level: params.level });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.buildNimbleCharacter', params);
    } catch (error) {
      throw new Error(
        `Failed to build character: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
