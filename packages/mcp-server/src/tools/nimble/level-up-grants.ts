/**
 * Nimble: check-level-up-grants (read-only)
 *
 * Reports which subclasses Nimble's level-up dialog would offer for a class
 * and which features it would grant at a level, plus authoring warnings.
 * The analysis runs browser-side (foundry-module/src/nimble-level-up.ts),
 * which documents the Nimble system functions it mirrors.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface NimbleLevelUpGrantsToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class NimbleLevelUpGrantsTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: NimbleLevelUpGrantsToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'NimbleLevelUpGrantsTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'check-level-up-grants',
        description:
          "Nimble only, read-only. Verify that a class/subclass will work in Nimble's level-up dialog " +
          'without levelling a character. Returns the subclasses offered for the class (world + compendium, ' +
          'with source), the class and subclass features granted at the level, and warnings (subclass/feature ' +
          'group mismatches, gainedAtLevel not in gainedAtLevels, duplicate identifiers, bad activation ' +
          'effect ids). Note: Nimble keys subclass features by the slugified subclass NAME ' +
          '("Path of Ash" → "path-of-ash"); feature system.group must equal that.',
        inputSchema: {
          type: 'object',
          properties: {
            classIdentifier: {
              type: 'string',
              description: 'Class identifier (slugified class name), e.g. "shepherd".',
            },
            subclassIdentifier: {
              type: 'string',
              description:
                'Optional subclass (slugified name, name, or stored identifier). Omit to report every subclass of the class.',
            },
            level: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              description: 'Level being levelled to (subclass choice happens at 3).',
            },
          },
          required: ['classIdentifier', 'level'],
        },
      },
    ];
  }

  async handleCheckLevelUpGrants(args: any): Promise<any> {
    const params = z
      .object({
        classIdentifier: z.string().min(1, 'classIdentifier is required'),
        subclassIdentifier: z.string().min(1).optional(),
        level: z.number().int().min(1).max(20),
      })
      .parse(args);

    this.logger.info('Checking Nimble level-up grants', params);

    try {
      return await this.foundryClient.query('foundry-mcp-bridge.checkNimbleLevelUpGrants', params);
    } catch (error) {
      this.logger.error('Failed to check level-up grants', error);
      throw new Error(
        `Failed to check level-up grants: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
