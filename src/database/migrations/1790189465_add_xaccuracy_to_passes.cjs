'use strict';

/**
 * Internal xaccuracy for accuracy-sort tiebreaks.
 *
 * Displayed `accuracy` still treats Perfect− / Perfect+ as 1.0.
 * `xaccuracy` uses the same buckets with Perfect− / Perfect+ at 0.9 so a
 * mixed 100% ranks below a full x-perfect without changing the public value.
 *
 * Judgement BEFORE INSERT/UPDATE sets both columns; AFTER INSERT/UPDATE copies
 * them onto `passes`. A no-op UPDATE on judgements backfills existing rows.
 * Pass mapping hash change reindexes Elasticsearch after deploy.
 */

const CALC_XACC_FN = `
      CREATE FUNCTION calculate_xaccuracy(
        early_double BIGINT UNSIGNED,
        early_single BIGINT UNSIGNED,
        e_perfect BIGINT UNSIGNED,
        perfect_minus BIGINT UNSIGNED,
        perfect BIGINT UNSIGNED,
        perfect_plus BIGINT UNSIGNED,
        l_perfect BIGINT UNSIGNED,
        late_single BIGINT UNSIGNED,
        late_double BIGINT UNSIGNED
      ) RETURNS DOUBLE
      DETERMINISTIC
      BEGIN
        DECLARE total_tiles BIGINT UNSIGNED;
        DECLARE weighted_sum DOUBLE;

        SET total_tiles = early_double + early_single + e_perfect + perfect_minus
          + perfect + perfect_plus + l_perfect + late_single + late_double;

        IF total_tiles = 0 THEN
          RETURN NULL;
        END IF;

        SET weighted_sum = perfect
                          + (perfect_minus + perfect_plus) * 0.9
                          + (e_perfect + l_perfect) * 0.75
                          + (early_single + late_single) * 0.4
                          + (early_double + late_double) * 0.2;

        RETURN weighted_sum / total_tiles;
      END
`;

async function dropJudgementAccuracyTriggers(queryInterface) {
  await queryInterface.sequelize.query(`
    DROP TRIGGER IF EXISTS update_judgement_accuracy;
  `);
  await queryInterface.sequelize.query(`
    DROP TRIGGER IF EXISTS update_judgement_accuracy_on_update;
  `);
}

async function dropPassAccuracyCopyTriggers(queryInterface) {
  await queryInterface.sequelize.query(`
    DROP TRIGGER IF EXISTS update_pass_accuracy_on_judgement;
  `);
  await queryInterface.sequelize.query(`
    DROP TRIGGER IF EXISTS update_pass_accuracy_on_judgement_update;
  `);
}

async function createJudgementAccuracyAndXaccuracyTriggers(queryInterface) {
  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_judgement_accuracy
    BEFORE INSERT ON judgements
    FOR EACH ROW
    BEGIN
      SET NEW.accuracy = calculate_accuracy(
        NEW.earlyDouble,
        NEW.earlySingle,
        NEW.ePerfect,
        NEW.perfectMinus,
        NEW.perfect,
        NEW.perfectPlus,
        NEW.lPerfect,
        NEW.lateSingle,
        NEW.lateDouble
      );
      SET NEW.xaccuracy = calculate_xaccuracy(
        NEW.earlyDouble,
        NEW.earlySingle,
        NEW.ePerfect,
        NEW.perfectMinus,
        NEW.perfect,
        NEW.perfectPlus,
        NEW.lPerfect,
        NEW.lateSingle,
        NEW.lateDouble
      );
    END
  `);

  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_judgement_accuracy_on_update
    BEFORE UPDATE ON judgements
    FOR EACH ROW
    BEGIN
      SET NEW.accuracy = calculate_accuracy(
        NEW.earlyDouble,
        NEW.earlySingle,
        NEW.ePerfect,
        NEW.perfectMinus,
        NEW.perfect,
        NEW.perfectPlus,
        NEW.lPerfect,
        NEW.lateSingle,
        NEW.lateDouble
      );
      SET NEW.xaccuracy = calculate_xaccuracy(
        NEW.earlyDouble,
        NEW.earlySingle,
        NEW.ePerfect,
        NEW.perfectMinus,
        NEW.perfect,
        NEW.perfectPlus,
        NEW.lPerfect,
        NEW.lateSingle,
        NEW.lateDouble
      );
    END
  `);
}

async function createAccuracyOnlyJudgementTriggers(queryInterface) {
  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_judgement_accuracy
    BEFORE INSERT ON judgements
    FOR EACH ROW
    BEGIN
      SET NEW.accuracy = calculate_accuracy(
        NEW.earlyDouble,
        NEW.earlySingle,
        NEW.ePerfect,
        NEW.perfectMinus,
        NEW.perfect,
        NEW.perfectPlus,
        NEW.lPerfect,
        NEW.lateSingle,
        NEW.lateDouble
      );
    END
  `);

  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_judgement_accuracy_on_update
    BEFORE UPDATE ON judgements
    FOR EACH ROW
    BEGIN
      SET NEW.accuracy = calculate_accuracy(
        NEW.earlyDouble,
        NEW.earlySingle,
        NEW.ePerfect,
        NEW.perfectMinus,
        NEW.perfect,
        NEW.perfectPlus,
        NEW.lPerfect,
        NEW.lateSingle,
        NEW.lateDouble
      );
    END
  `);
}

async function createPassAccuracyAndXaccuracyCopyTriggers(queryInterface) {
  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_pass_accuracy_on_judgement
    AFTER INSERT ON judgements
    FOR EACH ROW
    BEGIN
      UPDATE passes
      SET accuracy = NEW.accuracy,
          xaccuracy = NEW.xaccuracy
      WHERE id = NEW.id;
    END
  `);

  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_pass_accuracy_on_judgement_update
    AFTER UPDATE ON judgements
    FOR EACH ROW
    BEGIN
      UPDATE passes
      SET accuracy = NEW.accuracy,
          xaccuracy = NEW.xaccuracy
      WHERE id = NEW.id;
    END
  `);
}

async function createPassAccuracyOnlyCopyTriggers(queryInterface) {
  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_pass_accuracy_on_judgement
    AFTER INSERT ON judgements
    FOR EACH ROW
    BEGIN
      UPDATE passes
      SET accuracy = NEW.accuracy
      WHERE id = NEW.id;
    END
  `);

  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_pass_accuracy_on_judgement_update
    AFTER UPDATE ON judgements
    FOR EACH ROW
    BEGIN
      UPDATE passes
      SET accuracy = NEW.accuracy
      WHERE id = NEW.id;
    END
  `);
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('judgements', 'xaccuracy', {
      type: Sequelize.DOUBLE,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('passes', 'xaccuracy', {
      type: Sequelize.DOUBLE,
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS calculate_xaccuracy;`);
    await queryInterface.sequelize.query(CALC_XACC_FN);

    await dropJudgementAccuracyTriggers(queryInterface);
    await createJudgementAccuracyAndXaccuracyTriggers(queryInterface);

    await dropPassAccuracyCopyTriggers(queryInterface);
    await createPassAccuracyAndXaccuracyCopyTriggers(queryInterface);

    await queryInterface.sequelize.query(`
      UPDATE judgements SET perfect = perfect;
    `);
  },

  async down(queryInterface) {
    await dropJudgementAccuracyTriggers(queryInterface);
    await dropPassAccuracyCopyTriggers(queryInterface);

    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS calculate_xaccuracy;`);

    await createAccuracyOnlyJudgementTriggers(queryInterface);
    await createPassAccuracyOnlyCopyTriggers(queryInterface);

    await queryInterface.removeColumn('passes', 'xaccuracy');
    await queryInterface.removeColumn('judgements', 'xaccuracy');
  },
};
