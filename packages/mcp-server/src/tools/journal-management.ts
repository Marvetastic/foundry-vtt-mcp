/**
 * Journal Management Tool (manage-journals)
 *
 * GM-only CRUD for world JournalEntry documents and their text pages.
 * Complements the quest-oriented journal tools (create-quest-journal,
 * update-quest-journal, replace-journal-page, list-journals, search-journals);
 * page writes reuse the same browser-side updateJournalContent path.
 * Compendium journals are never modified.
 */

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface JournalManagementToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const ACTIONS = [
  'create',
  'get',
  'update-page',
  'append',
  'add-page',
  'delete',
  'list-folders',
] as const;

const worldId = z
  .string()
  .min(1)
  .refine(id => !id.startsWith('Compendium.'), {
    message: 'Compendium journals cannot be modified; only world journals',
  });

const pageSchema = z.object({
  name: z.string().min(1, 'Page name cannot be empty'),
  html: z.string(),
});

const schemas = {
  create: z.object({
    name: z.string().min(1, 'Journal name cannot be empty'),
    folder: z.string().min(1).optional(),
    pages: z.array(pageSchema).min(1, 'Provide at least one page'),
    visibility: z.enum(['gm', 'players']).default('gm'),
  }),
  get: z.object({ entry: z.string().min(1, 'entry (id or name) is required') }),
  'update-page': z
    .object({
      entry: worldId,
      pageId: z.string().min(1, 'pageId is required'),
      html: z.string().optional(),
      name: z.string().min(1).optional(),
    })
    .refine(v => v.html !== undefined || v.name !== undefined, {
      message: 'Provide html and/or name to update',
    }),
  append: z.object({
    entry: worldId,
    pageId: z.string().min(1, 'pageId is required'),
    html: z.string().min(1, 'html is required'),
  }),
  'add-page': z.object({
    entry: worldId,
    name: z.string().min(1, 'Page name cannot be empty'),
    html: z.string(),
  }),
  delete: z.object({
    entryIds: z.array(worldId).min(1, 'Provide at least one id in entryIds'),
    confirm: z.literal(true, {
      errorMap: () => ({ message: 'Deleting requires confirm: true' }),
    }),
  }),
  'list-folders': z.object({}),
} as const;

export class JournalManagementTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: JournalManagementToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'JournalManagementTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-journals',
        description:
          'Manage world Journal Entries and their text pages (GM-only). Compendium journals are never modified.\n' +
          '- "create": new entry with name, pages [{name, html}], optional folder (name or id; created if absent) and ' +
          'visibility "gm" (default, hidden from players) or "players" (players can view). Returns entry id and page ids.\n' +
          '- "get": entry by id or name → every page with full HTML, plus ownership.\n' +
          '- "update-page": entry + pageId → replace the page HTML and/or rename it (name).\n' +
          '- "append": entry + pageId + html → add html to the end of the page.\n' +
          '- "add-page": entry + name + html → add a new text page.\n' +
          '- "delete": entryIds + confirm:true → permanently delete world entries.\n' +
          '- "list-folders": journal folders with ids and parent.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            name: {
              type: 'string',
              description:
                'For "create": entry name. For "add-page": new page name. For "update-page": new page name (rename).',
            },
            folder: {
              type: 'string',
              description: 'For "create": folder name or id; created if absent.',
            },
            pages: {
              type: 'array',
              description: 'For "create": pages to create, in order.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  html: { type: 'string', description: 'Page content as HTML' },
                },
                required: ['name', 'html'],
              },
            },
            visibility: {
              type: 'string',
              enum: ['gm', 'players'],
              description: 'For "create": "gm" (default, ownership NONE) or "players" (OBSERVER).',
            },
            entry: {
              type: 'string',
              description:
                'For "get", "update-page", "append", "add-page": journal entry id or exact name.',
            },
            pageId: { type: 'string', description: 'For "update-page" and "append".' },
            html: {
              type: 'string',
              description: 'For "update-page" (replacement), "append" and "add-page".',
            },
            entryIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'For "delete": world journal entry ids.',
            },
            confirm: { type: 'boolean', description: 'Required (must be true) for "delete".' },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleManageJournals(args: any): Promise<any> {
    const { action } = z.object({ action: z.enum(ACTIONS) }).parse(args);
    const params = schemas[action].parse(args);

    this.logger.info('Managing journals', { action });

    try {
      return await this.foundryClient.query('foundry-mcp-bridge.manageJournals', {
        action,
        ...params,
      });
    } catch (error) {
      this.logger.error('Failed to manage journals', error);
      throw new Error(
        `Failed to ${action} journal: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
