import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses, standardErrorResponses400500, standardErrorResponses403404500, standardErrorResponses404500, standardErrorResponses500, stringIdParamSpec } from '@/server/schemas/v2/admin/index.js';
import { Op } from 'sequelize';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { DiscordGuild, DiscordSyncRole } from '@/models/discord/index.js';
import Difficulty from '@/models/levels/Difficulty.js';
import CurationType from '@/models/curations/CurationType.js';
import { roleSyncService } from '@/server/services/accounts/RoleSyncService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import sequelize from '@/config/db.js';

const router: Router = Router();

// ==================== GUILD ROUTES ====================

/**
 * GET /admin/discord/guilds
 */
router.get(
  '/guilds',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminDiscordGuilds',
    summary: 'List Discord guilds',
    description: 'List all Discord guilds with roles. Super admin.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Guilds' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const guilds = await DiscordGuild.findAll({
      include: [{
        model: DiscordSyncRole,
        as: 'roles',
        include: [
          { model: Difficulty, as: 'difficulty' },
          { model: CurationType, as: 'curationType' },
        ],
      }],
      attributes: {
        exclude: ['botToken'],
      },
      order: [['name', 'ASC']],
    });

    return res.json(guilds);
  } catch (error: any) {
    logger.error('Error fetching Discord guilds:', error);
    return res.status(500).json({ error: 'Failed to fetch guilds' });
  }
  }
);

/**
 * GET /admin/discord/guilds/:id
 */
router.get(
  '/guilds/:id',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminDiscordGuild',
    summary: 'Get Discord guild',
    description: 'Get single guild with roles. Super admin.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Guild' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const guild = await DiscordGuild.findByPk(id, {
      include: [{
        model: DiscordSyncRole,
        as: 'roles',
        include: [
          { model: Difficulty, as: 'difficulty' },
          { model: CurationType, as: 'curationType' },
        ],
        order: [['sortOrder', 'ASC']],
      }],
    });

    if (!guild) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    // toJSON already handles token masking
    return res.json(guild.toJSON());
  } catch (error: any) {
    logger.error('Error fetching Discord guild:', error);
    return res.status(500).json({ error: 'Failed to fetch guild' });
  }
  }
);

/**
 * POST /admin/discord/guilds
 */
router.post(
  '/guilds',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postAdminDiscordGuild',
    summary: 'Create Discord guild',
    description: 'Create guild. Body: guildId, name, botToken, isActive?. Super admin password.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    requestBody: { description: 'guildId, name, botToken, isActive', schema: { type: 'object', properties: { guildId: { type: 'string' }, name: { type: 'string' }, botToken: { type: 'string' }, isActive: { type: 'boolean' } }, required: ['guildId', 'name', 'botToken'] }, required: true },
    responses: { 201: { description: 'Guild created' }, ...standardErrorResponses400500, 409: { schema: errorResponseSchema } },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { guildId, name, botToken, isActive = true } = req.body;

    if (!guildId || !name || !botToken) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'guildId, name, and botToken are required' });
    }

    // Check for duplicate guildId
    const existing = await DiscordGuild.findOne({
      where: { guildId },
      transaction,
    });

    if (existing) {
      await safeTransactionRollback(transaction);
      return res.status(409).json({ error: 'A guild with this ID already exists' });
    }

    const guild = await DiscordGuild.create({
      guildId,
      name,
      botToken,
      isActive,
    }, { transaction });

    await transaction.commit();

    // Test bot permissions after creation
    logger.debug(`Testing bot permissions for newly created guild ${guildId}`);
    const permissionTest = await roleSyncService.testBotPermissions(botToken, guildId);
    if (!permissionTest.success) {
      logger.warn(`Bot permission test failed for guild ${guildId}: ${permissionTest.error}`);
      // Don't fail the request, but log the warning
    } else {
      logger.debug(`Bot permission test passed for guild ${guildId}`);
    }

    // toJSON already handles token masking
    return res.status(201).json(guild.toJSON());
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating Discord guild:', error);
    return res.status(500).json({ error: 'Failed to create guild' });
  }
  }
);

/**
 * PUT /admin/discord/guilds/:id
 */
router.put(
  '/guilds/:id',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putAdminDiscordGuild',
    summary: 'Update Discord guild',
    description: 'Update guild. Body: guildId, name, botToken?, isActive?. Super admin password.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'guildId, name, botToken, isActive', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Guild updated' }, ...standardErrorResponses404500, 409: { schema: errorResponseSchema } },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { id } = req.params;
    const { guildId, name, botToken, isActive } = req.body;

    const guild = await DiscordGuild.findByPk(id, { transaction });
    if (!guild) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Check for duplicate guildId if changing
    if (guildId && guildId !== guild.guildId) {
      const existing = await DiscordGuild.findOne({
        where: { guildId, id: { [Op.ne]: id } },
        transaction,
      });
      if (existing) {
        await safeTransactionRollback(transaction);
        return res.status(409).json({ error: 'A guild with this ID already exists' });
      }
    }

    // Update fields
    // Only update botToken if it's provided and not the masked placeholder value
    // This prevents accidentally overwriting a valid token with the masked placeholder
    const botTokenUpdated = botToken !== undefined &&
                           botToken !== null &&
                           botToken !== '' &&
                           botToken !== '••••••••' &&
                           (typeof botToken === 'string' ? botToken.trim() !== '••••••••' : true);

    if (guildId !== undefined) guild.guildId = guildId;
    if (name !== undefined) guild.name = name;
    if (botTokenUpdated) {
      guild.botToken = botToken;
      logger.debug(`Updating bot token for guild ${guild.guildId}`);
    } else if (botToken !== undefined && botToken === '••••••••') {
      logger.debug(`Skipping bot token update for guild ${guild.guildId} - masked placeholder value provided`);
    }
    if (isActive !== undefined) guild.isActive = isActive;

    await guild.save({ transaction });
    await transaction.commit();

    // Test bot permissions if bot token was updated
    if (botTokenUpdated) {
      const finalGuildId = guildId !== undefined ? guildId : guild.guildId;
      logger.debug(`Testing bot permissions for updated guild ${finalGuildId}`);
      const permissionTest = await roleSyncService.testBotPermissions(
        botToken!,
        finalGuildId
      );
      if (!permissionTest.success) {
        logger.warn(`Bot permission test failed for guild ${finalGuildId}: ${permissionTest.error}`);
        // Don't fail the request, but log the warning
      } else {
        logger.debug(`Bot permission test passed for guild ${finalGuildId}`);
      }
    }

    // toJSON already handles token masking
    return res.json(guild.toJSON());
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating Discord guild:', error);
    return res.status(500).json({ error: 'Failed to update guild' });
  }
  }
);

/**
 * DELETE /admin/discord/guilds/:id
 */
router.delete(
  '/guilds/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteAdminDiscordGuild',
    summary: 'Delete Discord guild',
    description: 'Delete guild and its roles. Super admin password.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 204: { description: 'Guild deleted' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { id } = req.params;

    const guild = await DiscordGuild.findByPk(id, { transaction });
    if (!guild) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Delete all roles first (CASCADE should handle this, but be explicit)
    await DiscordSyncRole.destroy({
      where: { discordGuildId: id },
      transaction,
    });

    await guild.destroy({ transaction });
    await transaction.commit();

    return res.status(204).end();
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting Discord guild:', error);
    return res.status(500).json({ error: 'Failed to delete guild' });
  }
  }
);

// ==================== ROLE ROUTES ====================

/**
 * GET /admin/discord/guilds/:guildId/roles
 */
router.get(
  '/guilds/:guildId([0-9]{1,20})/roles',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminDiscordGuildRoles',
    summary: 'List guild roles',
    description: 'List Discord sync roles for a guild. Super admin.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { guildId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Roles' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { guildId } = req.params;

    const guild = await DiscordGuild.findByPk(guildId);
    if (!guild) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    const roles = await DiscordSyncRole.findAll({
      where: { discordGuildId: guildId },
      include: [
        { model: Difficulty, as: 'difficulty' },
        { model: CurationType, as: 'curationType' },
      ],
      order: [['sortOrder', 'ASC']],
    });

    return res.json(roles);
  } catch (error: any) {
    logger.error('Error fetching Discord roles:', error);
    return res.status(500).json({ error: 'Failed to fetch roles' });
  }
  }
);

/**
 * POST /admin/discord/guilds/:guildId/roles
 */
router.post(
  '/guilds/:guildId([0-9]{1,20})/roles',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postAdminDiscordGuildRole',
    summary: 'Create guild role',
    description: 'Create sync role. Body: roleId, label, type (DIFFICULTY|CURATION), minDifficultyId?, curationTypeId?, etc. Super admin password.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { guildId: { schema: { type: 'string' } } },
    requestBody: { description: 'roleId, label, type, minDifficultyId, curationTypeId, conflictGroup, isActive, sortOrder', schema: { type: 'object' }, required: true },
    responses: { 201: { description: 'Role created' }, ...standardErrorResponses, 403: { schema: errorResponseSchema } },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { guildId } = req.params;
    const {
      roleId,
      label,
      type,
      minDifficultyId,
      curationTypeId,
      conflictGroup,
      isActive = true,
      sortOrder = 0,
    } = req.body;

    const guild = await DiscordGuild.findByPk(guildId, { transaction });
    if (!guild) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Guild not found' });
    }

    if (!roleId || !label || !type) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'roleId, label, and type are required' });
    }

    if (!['DIFFICULTY', 'CURATION'].includes(type)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'type must be DIFFICULTY or CURATION' });
    }

    // Validate type-specific fields
    if (type === 'DIFFICULTY' && !minDifficultyId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'minDifficultyId is required for DIFFICULTY type roles' });
    }

    if (type === 'CURATION' && !curationTypeId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'curationTypeId is required for CURATION type roles' });
    }

    // Test if bot can manage this role before saving
    if (guild.botToken) {
      logger.debug(`Testing role assignment permission for role ${roleId} in guild ${guild.guildId}`);
      const permissionTest = await roleSyncService.testRoleAssignmentPermission(
        guild.botToken,
        guild.guildId,
        roleId
      );

      if (!permissionTest.success || !permissionTest.canManageRole) {
        await safeTransactionRollback(transaction);
        const errorMsg = permissionTest.error || 'Bot cannot manage this role';
        logger.warn(`Role assignment permission test failed for role ${roleId} in guild ${guild.guildId}: ${errorMsg}`);
        return res.status(403).json({
          error: `Bot cannot manage this role: ${errorMsg}`,
          details: 'The bot token does not have permission to assign this role. Please ensure the bot has the "Manage Roles" permission and that the role is positioned below the bot\'s highest role.',
        });
      }
      logger.debug(`Role assignment permission test passed for role ${roleId} in guild ${guild.guildId}`);
    } else {
      logger.warn(`Cannot test role permissions: Guild ${guild.guildId} has no bot token`);
    }

    const role = await DiscordSyncRole.create({
      discordGuildId: parseInt(guildId as string),
      roleId,
      label,
      type,
      minDifficultyId: type === 'DIFFICULTY' ? minDifficultyId : null,
      curationTypeId: type === 'CURATION' ? curationTypeId : null,
      conflictGroup: conflictGroup || null,
      isActive,
      sortOrder,
    }, { transaction });

    await transaction.commit();

    // Reload with associations
    const roleWithAssociations = await DiscordSyncRole.findByPk(role.id, {
      include: [
        { model: Difficulty, as: 'difficulty' },
        { model: CurationType, as: 'curationType' },
      ],
    });

    return res.status(201).json(roleWithAssociations);
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error creating Discord role:', error);
    return res.status(500).json({ error: 'Failed to create role' });
  }
  }
);

/**
 * PUT /admin/discord/guilds/:guildId/roles/:roleId
 */
router.put(
  '/guilds/:guildId([0-9]{1,20})/roles/:roleId([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putAdminDiscordGuildRole',
    summary: 'Update guild role',
    description: 'Update sync role. Super admin password.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { guildId: { schema: { type: 'string' } }, roleId: { schema: { type: 'string' } } },
    requestBody: { description: 'roleId, label, type, minDifficultyId, curationTypeId, conflictGroup, isActive, sortOrder', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Role updated' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { guildId, roleId } = req.params;
    const {
      roleId: newRoleId,
      label,
      type,
      minDifficultyId,
      curationTypeId,
      conflictGroup,
      isActive,
      sortOrder,
    } = req.body;

    const role = await DiscordSyncRole.findByPk(roleId, { transaction });
    if (!role || role.discordGuildId !== parseInt(guildId)) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Role not found in this guild' });
    }

    // Update roleId if provided (allow duplicates - multiple rules can target same roleId)
    if (newRoleId !== undefined && newRoleId !== role.roleId) {
      role.roleId = newRoleId;
    }

    // Update fields
    if (label !== undefined) role.label = label;
    if (type !== undefined) {
      if (!['DIFFICULTY', 'CURATION'].includes(type)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'type must be DIFFICULTY or CURATION' });
      }
      role.type = type;
    }
    if (minDifficultyId !== undefined) role.minDifficultyId = minDifficultyId;
    if (curationTypeId !== undefined) role.curationTypeId = curationTypeId;
    if (conflictGroup !== undefined) role.conflictGroup = conflictGroup;
    if (isActive !== undefined) role.isActive = isActive;
    if (sortOrder !== undefined) role.sortOrder = sortOrder;

    await role.save({ transaction });
    await transaction.commit();

    // Reload with associations
    const roleWithAssociations = await DiscordSyncRole.findByPk(role.id, {
      include: [
        { model: Difficulty, as: 'difficulty' },
        { model: CurationType, as: 'curationType' },
      ],
    });

    return res.json(roleWithAssociations);
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating Discord role:', error);
    return res.status(500).json({ error: 'Failed to update role' });
  }
  }
);

/**
 * DELETE /admin/discord/guilds/:guildId/roles/:roleId
 */
router.delete(
  '/guilds/:guildId([0-9]{1,20})/roles/:roleId([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteAdminDiscordGuildRole',
    summary: 'Delete guild role',
    description: 'Delete sync role. Super admin password.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { guildId: { schema: { type: 'string' } }, roleId: { schema: { type: 'string' } } },
    responses: { 204: { description: 'Role deleted' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { guildId, roleId } = req.params;

    const role = await DiscordSyncRole.findByPk(roleId, { transaction });
    if (!role || role.discordGuildId !== parseInt(guildId)) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Role not found in this guild' });
    }

    await role.destroy({ transaction });
    await transaction.commit();

    return res.status(204).end();
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting Discord role:', error);
    return res.status(500).json({ error: 'Failed to delete role' });
  }
  }
);

/**
 * PUT /admin/discord/guilds/:guildId/roles/reorder
 */
router.put(
  '/guilds/:guildId([0-9]{1,20})/roles/reorder',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putAdminDiscordGuildRolesReorder',
    summary: 'Reorder guild roles',
    description: 'Body: roleIds (array of role IDs in desired order). Super admin password.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { guildId: { schema: { type: 'string' } } },
    requestBody: { description: 'roleIds', schema: { type: 'object', properties: { roleIds: { type: 'array', items: { type: 'integer' } } }, required: ['roleIds'] }, required: true },
    responses: { 200: { description: 'Roles reordered' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { guildId } = req.params;
    const { roleIds } = req.body;

    // Validate request body
    if (!Array.isArray(roleIds)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'roleIds must be an array' });
    }

    if (roleIds.length === 0) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'roleIds array cannot be empty' });
    }

    // Parse and validate role IDs
    const parsedRoleIds = roleIds.map(id => {
      const parsed = parseInt(id, 10);
      if (isNaN(parsed) || parsed <= 0) {
        throw new Error(`Invalid role ID: ${id}`);
      }
      return parsed;
    });

    // Check for duplicates
    if (new Set(parsedRoleIds).size !== parsedRoleIds.length) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'roleIds array contains duplicate IDs' });
    }

    const guild = await DiscordGuild.findByPk(guildId, { transaction });
    if (!guild) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Verify all roles exist and belong to this guild
    const existingRoles = await DiscordSyncRole.findAll({
      where: {
        id: { [Op.in]: parsedRoleIds },
        discordGuildId: parseInt(guildId as string),
      },
      transaction,
    });

    if (existingRoles.length !== parsedRoleIds.length) {
      await safeTransactionRollback(transaction);
      const foundIds = existingRoles.map(r => r.id);
      const missingIds = parsedRoleIds.filter(id => !foundIds.includes(id));
      return res.status(400).json({
        error: 'Some role IDs do not exist or do not belong to this guild',
        missingIds
      });
    }

    // Update sort orders based on array index
    for (let i = 0; i < parsedRoleIds.length; i++) {
      await DiscordSyncRole.update(
        { sortOrder: i },
        { where: { id: parsedRoleIds[i], discordGuildId: parseInt(guildId as string) }, transaction }
      );
    }

    await transaction.commit();

    // Return updated roles sorted by sortOrder
    const roles = await DiscordSyncRole.findAll({
      where: { discordGuildId: parseInt(guildId as string) },
      include: [
        { model: Difficulty, as: 'difficulty' },
        { model: CurationType, as: 'curationType' },
      ],
      order: [['sortOrder', 'ASC']],
    });

    return res.json(roles);
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Error reordering Discord roles:', error);

    // Return more specific error messages
    if (error.message && error.message.includes('Invalid role ID')) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(500).json({ error: 'Failed to reorder roles' });
  }
  }
);

// ==================== SYNC ROUTES ====================

/**
 * POST /admin/discord/sync/user/:userId
 */
router.post(
  '/sync/user/:userId',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminDiscordSyncUser',
    summary: 'Sync user roles',
    description: 'Manually trigger Discord role sync for a user. Super admin.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { userId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Sync result' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const result = await roleSyncService.manualSync(userId);

    return res.json({
      success: true,
      result,
    });
  } catch (error: any) {
    logger.error('Error syncing Discord roles:', error);
    return res.status(500).json({ error: 'Failed to sync roles' });
  }
  }
);

/**
 * POST /admin/discord/sync/player/:playerId
 */
router.post(
  '/sync/player/:playerId',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminDiscordSyncPlayer',
    summary: 'Sync player roles',
    description: 'Trigger difficulty role sync for a player. Super admin.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { playerId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Sync result' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { playerId } = req.params;

    const result = await roleSyncService.syncDifficultyRolesForPlayer(parseInt(playerId));

    return res.json({
      success: true,
      result,
    });
  } catch (error: any) {
    logger.error('Error syncing Discord difficulty roles:', error);
    return res.status(500).json({ error: 'Failed to sync difficulty roles' });
  }
  }
);

/**
 * POST /admin/discord/sync/creator/:creatorId
 */
router.post(
  '/sync/creator/:creatorId',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminDiscordSyncCreator',
    summary: 'Sync creator roles',
    description: 'Trigger curation role sync for a creator. Super admin.',
    tags: ['Admin', 'Discord'],
    security: ['bearerAuth'],
    params: { creatorId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Sync result' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { creatorId } = req.params;

    const result = await roleSyncService.syncCurationRolesForCreator(parseInt(creatorId));

    return res.json({
      success: true,
      result,
    });
  } catch (error: any) {
    logger.error('Error syncing Discord curation roles:', error);
    return res.status(500).json({ error: 'Failed to sync curation roles' });
  }
  }
);

export default router;
