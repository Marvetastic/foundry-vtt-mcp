/**
 * Nimble: describe-nimble-rules, get-actor-resources, use-reaction, rest
 *
 * All four read or drive live Nimble state. The browser side
 * (foundry-module/src/nimble-rules.ts, nimble-resources.ts, nimble-reactions.ts)
 * documents the Nimble functions and data they use.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface NimbleRulesResourcesToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const describeSchema = z
  .object({
    type: z.string().min(1).optional(),
    validate: z.record(z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.validate && !v.type && typeof v.validate.type !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'validate needs a rule type: pass `type` or validate.type',
      });
    }
  });

const resourcesSchema = z.object({ actor: z.string().min(1, 'actor is required') });

const useReactionSchema = z.object({
  messageId: z.string().min(1, 'messageId is required'),
  offer: z.union([
    z.number().int().min(0, 'offer index must be 0 or more'),
    z.string().min(1, 'offer label must not be empty'),
  ]),
  actor: z.string().min(1).optional(),
  force: z.boolean().optional(),
  spend: z
    .object({
      faceIndices: z
        .array(z.number().int().min(0))
        .min(1, 'spend.faceIndices needs at least one die')
        .refine(list => new Set(list).size === list.length, 'spend.faceIndices must be unique'),
    })
    .optional(),
});

const restSchema = z.object({
  actor: z.string().min(1, 'actor is required'),
  restType: z.enum(['safe', 'field'], {
    errorMap: () => ({ message: 'restType must be "safe" or "field"' }),
  }),
});

export class NimbleRulesResourcesTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: NimbleRulesResourcesToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'NimbleRulesResourcesTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'describe-nimble-rules',
        description:
          'Nimble (read-only): the real schema of the rules-builder rule types, read live from the installed ' +
          "system's rule data models: every field with its type, required/nullable, default, allowed enum values " +
          '(incl. recovery/refill triggers and modes), min/max, plus a default-valued `template` and behaviour notes ' +
          '(e.g. chargePool/chargeConsumer pairing, modifyIncomingAttack range). Pass `type` for one rule type ' +
          '(chargePool, chargeConsumer, dicePool, diceConsumer, modifyIncomingAttack, damageReduction...). ' +
          'Pass `validate` (a rule JSON) to have Nimble validate it and list exactly what is wrong: an invalid ' +
          'rule is saved but force-disabled.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'One rule type; omit for all.' },
            validate: {
              type: 'object',
              description: 'A rule JSON to validate against its data model (needs type).',
            },
          },
        },
      },
      {
        name: 'get-actor-resources',
        description:
          "Nimble (read-only): an actor's charge pools and dice pools (identifier, scope, owning item, current, max, " +
          'die size, dice faces), the rules that are not running (failed validation, with the reason Nimble records, ' +
          'or switched off), every pool/consumer rule with whether its pool exists, active toggle effects, and the ' +
          'automation world settings that affect pools.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: { type: 'string', description: 'Actor id, uuid, or exact name.' },
          },
          required: ['actor'],
        },
      },
      {
        name: 'use-reaction',
        description:
          'Nimble (GM): take an offer from an attack card exactly as its button does. Offers are listed by ' +
          'read-chat-log under nimble.reactions (Interpose, force reroll, add-damage dice spends). `offer` is the ' +
          "index or the button label. A baseline Interpose in a started combat first spends the combatant's " +
          "interpose reaction and action cost; if that needs the card's confirmation (already spent, no actions, " +
          "own turn) pass force:true. Add-damage offers need spend.faceIndices (positions in the pool's faces, " +
          'from get-actor-resources). Returns whether it applied, the new targets, before/after offer state, ' +
          'reactor/original-target HP and conditions, the action cost, and any messages created.',
        inputSchema: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'The attack card chat message id.' },
            offer: {
              type: ['integer', 'string'],
              description: 'Offer index (0-based) or its label as read-chat-log shows it.',
            },
            actor: {
              type: 'string',
              description:
                'Optional: the reacting actor; refused if the offer belongs to someone else.',
            },
            force: {
              type: 'boolean',
              description: 'Confirm the spent/no-actions/own-turn prompt.',
            },
            spend: {
              type: 'object',
              properties: { faceIndices: { type: 'array', items: { type: 'integer' } } },
              description: 'For add-damage dice-pool offers: which dice to spend.',
            },
          },
          required: ['messageId', 'offer'],
        },
      },
      {
        name: 'rest',
        description:
          "Nimble (GM): trigger a Safe Rest or Field Rest for a character with Nimble's own rest logic and default " +
          'options (no dialog, no camp, no hit dice spent, no rest chat card), so pool recoveries (safeRest/fieldRest ' +
          'triggers) can be tested. Returns what changed: HP, temp HP, wounds, mana, hit dice, charge pools, dice pools.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: { type: 'string', description: 'Actor id, uuid, or exact name.' },
            restType: { type: 'string', enum: ['safe', 'field'] },
          },
          required: ['actor', 'restType'],
        },
      },
    ];
  }

  private async run(method: string, params: unknown, failure: string): Promise<any> {
    try {
      return await this.foundryClient.query(`foundry-mcp-bridge.${method}`, params);
    } catch (error) {
      throw new Error(`${failure}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async handleDescribeRules(args: any): Promise<any> {
    const params = describeSchema.parse(args ?? {});
    this.logger.info('Describing Nimble rules', { type: params.type });
    return this.run('describeNimbleRules', params, 'Failed to describe Nimble rules');
  }

  async handleGetActorResources(args: any): Promise<any> {
    const params = resourcesSchema.parse(args ?? {});
    this.logger.info('Reading actor resources', params);
    return this.run('getActorResources', params, 'Failed to get actor resources');
  }

  async handleUseReaction(args: any): Promise<any> {
    const params = useReactionSchema.parse(args ?? {});
    this.logger.info('Using reaction', { messageId: params.messageId, offer: params.offer });
    return this.run('useReaction', params, 'Failed to use reaction');
  }

  async handleRest(args: any): Promise<any> {
    const params = restSchema.parse(args ?? {});
    this.logger.info('Resting actor', params);
    return this.run('restActor', params, 'Failed to rest');
  }
}
