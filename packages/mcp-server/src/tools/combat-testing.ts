/**
 * Combat Testing Tools
 *
 * read-chat-log  — read recent chat messages with roll details (read-only).
 * manage-combat  — create / roll-initiative / start / next-turn / get / end an encounter.
 * apply-to-token — apply damage or healing (Nimble), raw or from a chat card.
 *
 * The document work runs browser-side (foundry-module/src/combat-tools.ts),
 * which documents the Nimble system functions it calls.
 */

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface CombatTestingToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const COMBAT_ACTIONS = ['create', 'roll-initiative', 'start', 'next-turn', 'get', 'end'] as const;

const nonEmptyIds = (what: string) =>
  z.array(z.string().min(1)).min(1, `Provide at least one ${what}`);

const combatSchemas = {
  create: z.object({
    scene: z.string().min(1).optional(),
    tokens: nonEmptyIds('token id or name in tokens'),
  }),
  'roll-initiative': z.object({
    combatId: z.string().min(1).optional(),
    combatants: z.array(z.string().min(1)).optional(),
  }),
  start: z.object({ combatId: z.string().min(1).optional() }),
  'next-turn': z.object({ combatId: z.string().min(1).optional() }),
  get: z.object({ combatId: z.string().min(1).optional() }),
  end: z.object({
    combatId: z.string().min(1).optional(),
    confirm: z.literal(true, {
      errorMap: () => ({ message: 'Ending combat requires confirm: true' }),
    }),
  }),
} as const;

const sinceTimestamp = z
  .union([z.number().nonnegative(), z.string().min(1)])
  .transform((value, ctx) => {
    if (typeof value === 'number') return value;
    const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (Number.isNaN(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sinceTimestamp must be ms or ISO date',
      });
      return z.NEVER;
    }
    return parsed;
  });

const readChatLogSchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(20),
    sinceMessageId: z.string().min(1).optional(),
    sinceTimestamp: sinceTimestamp.optional(),
    speaker: z.string().min(1).optional(),
    includeRolls: z.boolean().default(true),
  })
  .refine(v => !(v.sinceMessageId && v.sinceTimestamp !== undefined), {
    message: 'Use sinceMessageId or sinceTimestamp, not both',
  });

const applySchema = z
  .object({
    tokens: z.array(z.string().min(1)).optional(),
    scene: z.string().min(1).optional(),
    amount: z.number().positive().optional(),
    kind: z.enum(['damage', 'healing', 'tempHealing']).optional(),
    damageType: z.string().min(1).optional(),
    fromChatMessageId: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.fromChatMessageId) {
      if (v.amount !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'amount is taken from the chat card; omit it with fromChatMessageId',
        });
      }
      return;
    }
    if (!v.tokens || v.tokens.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tokens is required' });
    }
    if (v.amount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount is required' });
    }
    if (!v.kind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kind is required' });
    }
  });

export class CombatTestingTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: CombatTestingToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'CombatTestingTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'read-chat-log',
        description:
          'Read recent Foundry chat messages (read-only, oldest first). Each message has id, timestamp, speaker ' +
          '(actor and token), flavor, plain-text content, whisper/blind flags, the source item, and rolls ' +
          '(formula, total, every die). Nimble activation cards also get crit/miss, advantage, targets, each ' +
          'effect (damage/healing amount and type, conditions, saves; "applies" says whether it fires for the ' +
          'rolled outcome), any healing already applied from the card, and `reactions`: the offers on the card ' +
          '(Interpose, force reroll, add-damage dice spends) with index, label, who can take each, why ' +
          '(range, source rule/item) and whether it is used; take one with use-reaction. Nimble does not record damage ' +
          "application on the card; use apply-to-token's before/after instead. Use latestMessageId from one " +
          'call as sinceMessageId in the next to read only new messages.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 20.' },
            sinceMessageId: {
              type: 'string',
              description: 'Only messages after this message id.',
            },
            sinceTimestamp: {
              type: ['number', 'string'],
              description: 'Only messages after this time (ms since epoch or ISO date).',
            },
            speaker: { type: 'string', description: 'Filter by speaker actor name or id.' },
            includeRolls: { type: 'boolean', description: 'Include roll details (default true).' },
          },
        },
      },
      {
        name: 'manage-combat',
        description:
          'Run a combat encounter (GM-only). Only touches the Combat document and the tokens named.\n' +
          '- "create": scene (default: the viewed/active scene) + tokens (ids or names) → new encounter with those combatants.\n' +
          '- "roll-initiative": all combatants, or the listed ones, using the system\'s own initiative roll. ' +
          "In Nimble initiative sets each combatant's starting actions; it does not reorder turns.\n" +
          '- "start", "next-turn".\n' +
          '- "get": round, turn, current combatant and turn order with each combatant\'s HP, temp HP, wounds, ' +
          'conditions and remaining actions (Nimble).\n' +
          '- "end": requires confirm:true; deletes the encounter only (actors and tokens are untouched).\n' +
          'combatId defaults to the active encounter.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...COMBAT_ACTIONS] },
            combatId: { type: 'string' },
            scene: { type: 'string', description: 'For "create": scene id or name.' },
            tokens: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For "create": token ids or names on the scene (ambiguous names are refused).',
            },
            combatants: {
              type: 'array',
              items: { type: 'string' },
              description: 'For "roll-initiative": combatant ids or names (default all).',
            },
            confirm: { type: 'boolean', description: 'Required (true) for "end".' },
          },
          required: ['action'],
        },
      },
      {
        name: 'apply-to-token',
        description:
          'Nimble: apply damage or healing to tokens and return before/after HP, temp HP, wounds and conditions.\n' +
          "- With fromChatMessageId: apply exactly as the chat card's Apply Damage / healing buttons do " +
          "(armor, immunity, resistance and reductions from the roll). tokens, if given, replace the card's targets. " +
          'kind limits it to damage or one healing type.\n' +
          '- With amount + kind + tokens: raw damage (temp HP absorbs first; armor is NOT applied because Nimble ' +
          'resolves armor from the dice) or healing / tempHealing.\n' +
          "Dying, Wounds and Bloodied follow from Nimble's own rules.",
        inputSchema: {
          type: 'object',
          properties: {
            tokens: {
              type: 'array',
              items: { type: 'string' },
              description: 'Token ids or names on the scene.',
            },
            scene: { type: 'string', description: 'Scene id or name (default viewed/active).' },
            amount: { type: 'number', description: 'Raw amount (not with fromChatMessageId).' },
            kind: { type: 'string', enum: ['damage', 'healing', 'tempHealing'] },
            damageType: {
              type: 'string',
              description: 'Informational for raw damage; the card supplies it otherwise.',
            },
            fromChatMessageId: {
              type: 'string',
              description: 'A Nimble activation card id (from use-item autoRoll or read-chat-log).',
            },
          },
        },
      },
    ];
  }

  async handleReadChatLog(args: any): Promise<any> {
    const params = readChatLogSchema.parse(args ?? {});
    this.logger.info('Reading chat log', params);
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.readChatLog', params);
    } catch (error) {
      throw new Error(
        `Failed to read chat log: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleManageCombat(args: any): Promise<any> {
    const { action } = z.object({ action: z.enum(COMBAT_ACTIONS) }).parse(args);
    const params = combatSchemas[action].parse(args);
    this.logger.info('Managing combat', { action });
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.manageCombat', {
        action,
        ...params,
      });
    } catch (error) {
      throw new Error(
        `Failed to ${action} combat: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleApplyToToken(args: any): Promise<any> {
    const params = applySchema.parse(args);
    this.logger.info('Applying to tokens', params);
    try {
      return await this.foundryClient.query('foundry-mcp-bridge.applyToToken', params);
    } catch (error) {
      throw new Error(
        `Failed to apply to token: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
