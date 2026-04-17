import { Router, Request, Response } from 'express';
import Difficulty from '@/models/levels/Difficulty.js';
import AnnouncementDirective from '@/models/announcements/AnnouncementDirective.js';
import AnnouncementChannel from '@/models/announcements/AnnouncementChannel.js';
import AnnouncementRole from '@/models/announcements/AnnouncementRole.js';
import DirectiveAction from '@/models/announcements/DirectiveAction.js';
import {
  ConditionOperator,
  DirectiveCondition,
  DirectiveConditionType,
} from '@/server/interfaces/models/index.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses,
  standardErrorResponses404500,
  idParamSpec,
} from '@/server/schemas/v2/database/index.js';
import sequelize from '@/config/db.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { validateCustomDirective } from './shared.js';

/**
 * Announcement directives per difficulty.
 *
 * Writes are "replace all" — the client sends the complete desired directive
 * set and the server destroys the existing rows inside the same transaction
 * before recreating them. This trades incremental update UX for a dramatically
 * simpler server-side invariant (no orphaned actions, ordering is explicit).
 */

interface DirectiveInput {
  name: string;
  description: string;
  mode: 'STATIC' | 'CONDITIONAL';
  triggerType: 'PASS' | 'LEVEL';
  condition?: {
    type: DirectiveConditionType;
    value?: number;
    operator?: ConditionOperator;
    customFunction?: string;
  };
  actions: {
    channelId: number;
    pingType: 'NONE' | 'ROLE' | 'EVERYONE';
    roleId?: number;
  }[];
  isActive: boolean;
  firstOfKind: boolean;
  sortOrder?: number;
}

const router: Router = Router();

router.get(
  '/:id([0-9]{1,20})/directives',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'getDifficultyDirectives',
    summary: 'Get directives',
    description: 'Get announcement directives for a difficulty. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Directives' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const diffId = parseInt(req.params.id);

      const difficulty = await Difficulty.findByPk(diffId);
      if (!difficulty) {
        return res.status(404).json({ error: 'Difficulty not found' });
      }

      const directives = await AnnouncementDirective.findAll({
        where: {
          difficultyId: diffId,
          isActive: true,
        },
        order: [['sortOrder', 'ASC'], ['id', 'ASC']],
        include: [{
          model: DirectiveAction,
          as: 'actions',
          include: [
            {
              model: AnnouncementChannel,
              as: 'channel',
              attributes: ['id', 'label', 'webhookUrl'],
            },
            {
              model: AnnouncementRole,
              as: 'role',
              attributes: ['id', 'roleId', 'label', 'messageFormat'],
            },
          ],
        }],
      });

      return res.json(directives);
    } catch (error) {
      logger.error('Error fetching announcement directives:', error);
      return res.status(500).json({ error: 'Failed to fetch announcement directives' });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/directives',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postDifficultyDirectives',
    summary: 'Set directives',
    description: 'Replace announcement directives for a difficulty. Body: directives[]. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'directives array', schema: { type: 'object', properties: { directives: { type: 'array', items: { type: 'object' } } }, required: ['directives'] }, required: true },
    responses: { 200: { description: 'Directives updated' }, ...standardErrorResponses },
  }),
  async (req, res) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const id = parseInt(req.params.id);
      const directives: DirectiveInput[] = req.body.directives;

      const difficulty = await Difficulty.findByPk(id);
      if (!difficulty) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Difficulty not found' });
      }

      for (const directive of directives) {
        if (!directive.name || !directive.actions || !directive.mode || !directive.triggerType) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid directive format' });
        }

        if (!['STATIC', 'CONDITIONAL'].includes(directive.mode)) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid directive mode' });
        }

        if (!['PASS', 'LEVEL'].includes(directive.triggerType)) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'Invalid trigger type' });
        }

        if (directive.mode === 'CONDITIONAL') {
          if (!directive.condition) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({ error: 'Condition required for conditional mode' });
          }

          if (!DirectiveConditionType[directive.condition.type]) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({ error: 'Invalid condition type' });
          }

          switch (directive.condition.type) {
            case DirectiveConditionType.ACCURACY:
            case DirectiveConditionType.BASE_SCORE:
              if (directive.condition.value === undefined || !directive.condition.operator) {
                await safeTransactionRollback(transaction);
                return res.status(400).json({ error: 'Missing condition parameters' });
              }
              if (!ConditionOperator[directive.condition.operator]) {
                await safeTransactionRollback(transaction);
                return res.status(400).json({ error: 'Invalid operator' });
              }
              break;
            case DirectiveConditionType.CUSTOM:
              if (!directive.condition.customFunction) {
                await safeTransactionRollback(transaction);
                return res.status(400).json({ error: 'Missing custom function' });
              }
              const validation = validateCustomDirective(directive.condition as DirectiveCondition);
              if (!validation.isValid) {
                await safeTransactionRollback(transaction);
                return res.status(400).json({
                  error: 'Invalid custom directive format',
                  details: validation.error,
                });
              }
              break;
          }
        }

        for (const action of directive.actions) {
          if (!action.channelId || !['NONE', 'ROLE', 'EVERYONE'].includes(action.pingType)) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({ error: 'Invalid action format' });
          }
          if (action.pingType === 'ROLE' && !action.roleId) {
            await safeTransactionRollback(transaction);
            return res.status(400).json({ error: 'Role ID required for role pings' });
          }
        }
      }

      // Replace-all semantics: wipe and recreate everything inside one transaction
      // so a partial write can never leave orphaned actions referencing a stale directive.
      await AnnouncementDirective.destroy({
        where: { difficultyId: id },
        transaction,
      });

      const createdDirectives = await Promise.all(
        directives.map(async (directive, index) => {
          const createdDirective = await AnnouncementDirective.create({
            difficultyId: id,
            name: directive.name,
            description: directive.description,
            mode: directive.mode,
            triggerType: directive.triggerType,
            condition: directive.condition as DirectiveCondition,
            isActive: directive.isActive,
            firstOfKind: directive.firstOfKind,
            sortOrder: directive.sortOrder !== undefined ? directive.sortOrder : index,
            createdAt: new Date(),
            updatedAt: new Date(),
          }, { transaction });

          await Promise.all(
            directive.actions.map(async (action) => {
              const createdAction = await DirectiveAction.create({
                directiveId: createdDirective.id,
                channelId: action.channelId,
                pingType: action.pingType,
                roleId: action.roleId,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              }, { transaction });

              return createdAction;
            }),
          );

          return createdDirective;
        }),
      );

      await transaction.commit();

      const fullDirectives = await AnnouncementDirective.findAll({
        where: {
          id: createdDirectives.map(d => d.id),
        },
        include: [{
          model: DirectiveAction,
          as: 'actions',
          include: [
            {
              model: AnnouncementChannel,
              as: 'channel',
              attributes: ['id', 'label', 'webhookUrl'],
            },
            {
              model: AnnouncementRole,
              as: 'role',
              attributes: ['id', 'roleId', 'label', 'messageFormat'],
            },
          ],
        }],
      });

      return res.json(fullDirectives);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error creating directives:', error);
      return res.status(500).json({ error: 'Failed to create directives' });
    }
  },
);

export default router;
