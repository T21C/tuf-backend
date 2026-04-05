'use strict';

/** @type {import('sequelize-cli').Migration} */

function isNonEmpty(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  return true;
}

function firstNonEmpty(orderedRows, field) {
  for (const row of orderedRows) {
    const v = row[field];
    if (isNonEmpty(v)) return v;
  }
  return orderedRows[0]?.[field] ?? null;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    const qi = queryInterface.sequelize;

    try {
      await queryInterface.createTable(
        'curation_curation_types',
        {
          curationId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            primaryKey: true,
            references: {
              model: 'curations',
              key: 'id',
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          typeId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            primaryKey: true,
            references: {
              model: 'curation_types',
              key: 'id',
            },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
        },
        { transaction }
      );

      await queryInterface.addIndex('curation_curation_types', ['typeId'], {
        name: 'curation_curation_types_typeId_idx',
        transaction,
      });

      const [rows] = await qi.query(
        `
        SELECT c.id, c.levelId, c.typeId, c.shortDescription, c.description, c.previewLink,
               c.customCSS, c.customColor, c.assignedBy, c.createdAt, c.updatedAt,
               COALESCE(ct.groupSortOrder, 0) AS gs,
               COALESCE(ct.sortOrder, 0) AS so,
               ct.id AS typePk
        FROM curations c
        INNER JOIN curation_types ct ON c.typeId = ct.id
        ORDER BY c.levelId, gs ASC, so ASC, ct.id ASC, c.id ASC
        `,
        { transaction }
      );

      /** @type {Map<number, any[]>} */
      const byLevel = new Map();
      for (const r of rows) {
        const lid = r.levelId;
        if (!byLevel.has(lid)) byLevel.set(lid, []);
        byLevel.get(lid).push(r);
      }

      for (const [, list] of byLevel) {
        const ids = list.map((x) => x.id);
        const survivor = Math.min(...ids);
        const ordered = list;

        if (ids.length > 1) {
          const shortDescription = firstNonEmpty(ordered, 'shortDescription');
          const description = firstNonEmpty(ordered, 'description');
          const previewLink = firstNonEmpty(ordered, 'previewLink');
          const customCSS = firstNonEmpty(ordered, 'customCSS');
          const customColor = firstNonEmpty(ordered, 'customColor');

          await qi.query(
            `UPDATE curations SET shortDescription = :shortDescription, description = :description,
             previewLink = :previewLink, customCSS = :customCSS, customColor = :customColor
             WHERE id = :survivor`,
            {
              transaction,
              replacements: {
                survivor,
                shortDescription,
                description,
                previewLink,
                customCSS,
                customColor,
              },
            }
          );

          const others = ids.filter((id) => id !== survivor);
          if (others.length > 0) {
            await qi.query(
              `UPDATE curation_schedules SET curationId = :survivor WHERE curationId IN (:others)`,
              { transaction, replacements: { survivor, others } }
            );
            await qi.query(`DELETE FROM curations WHERE id IN (:others)`, {
              transaction,
              replacements: { others },
            });
          }
        }

        const typeIds = [...new Set(ordered.map((x) => x.typeId))];
        const now = new Date();
        for (const typeId of typeIds) {
          await qi.query(
            `INSERT INTO curation_curation_types (curationId, typeId, createdAt, updatedAt)
             VALUES (:curationId, :typeId, :now, :now)`,
            { transaction, replacements: { curationId: survivor, typeId, now } }
          );
        }
      }

      await queryInterface.removeConstraint('curations', 'curations_level_type_unique', {
        transaction,
      });

      const [fkRows] = await qi.query(
        `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'curations'
         AND COLUMN_NAME = 'typeId' AND REFERENCED_TABLE_NAME = 'curation_types'`,
        { transaction }
      );
      const fkName = fkRows?.[0]?.CONSTRAINT_NAME;
      if (fkName) {
        await qi.query(`ALTER TABLE curations DROP FOREIGN KEY \`${fkName}\``, { transaction });
      }

      await queryInterface.removeColumn('curations', 'typeId', { transaction });

      await queryInterface.addConstraint('curations', {
        fields: ['levelId'],
        type: 'unique',
        name: 'curations_levelId_unique',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeConstraint('curations', 'curations_levelId_unique', {
        transaction,
      });

      await queryInterface.addColumn(
        'curations',
        'typeId',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'curation_types',
            key: 'id',
          },
          onDelete: 'CASCADE',
        },
        { transaction }
      );

      await queryInterface.sequelize.query(
        `
        UPDATE curations c
        INNER JOIN curation_curation_types cct ON cct.curationId = c.id
        INNER JOIN (
          SELECT curationId, MIN(typeId) AS typeId FROM curation_curation_types GROUP BY curationId
        ) pick ON pick.curationId = c.id AND cct.typeId = pick.typeId
        SET c.typeId = pick.typeId
        `,
        { transaction }
      );

      await queryInterface.changeColumn(
        'curations',
        'typeId',
        {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'curation_types',
            key: 'id',
          },
          onDelete: 'CASCADE',
        },
        { transaction }
      );

      await queryInterface.addConstraint('curations', {
        fields: ['levelId', 'typeId'],
        type: 'unique',
        name: 'curations_level_type_unique',
        transaction,
      });

      await queryInterface.addIndex('curations', ['typeId'], { transaction });

      await queryInterface.dropTable('curation_curation_types', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
