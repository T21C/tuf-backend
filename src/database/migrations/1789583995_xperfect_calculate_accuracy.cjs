'use strict';

/**
 * Keep MySQL `calculate_accuracy` in sync with CalcAcc.ts.
 *
 * Perfect− / Perfect+ were added as 1.0-weight buckets, but the judgement
 * BEFORE INSERT/UPDATE trigger still used the 7-column formula. AFTER INSERT
 * then copied that value onto `passes.accuracy`, so an X-Perfect clear was
 * stored with JS score (correct) and SQL accuracy (Perfect± omitted). Resaving
 * a pass updates `passes.accuracy` after the trigger and appeared to "fix" it.
 */

const CALC_ACC_FN_NINE = `
      CREATE FUNCTION calculate_accuracy(
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
        DECLARE result DOUBLE;
        DECLARE perfect_band BIGINT UNSIGNED;

        SET total_tiles = early_double + early_single + e_perfect + perfect_minus
          + perfect + perfect_plus + l_perfect + late_single + late_double;

        IF total_tiles = 0 THEN
          RETURN NULL;
        END IF;

        SET perfect_band = perfect_minus + perfect + perfect_plus;
        SET weighted_sum = perfect_band
                          + (e_perfect + l_perfect) * 0.75
                          + (early_single + late_single) * 0.4
                          + (early_double + late_double) * 0.2;

        SET result = weighted_sum / total_tiles;

        RETURN result;
      END
`;

const CALC_ACC_FN_SEVEN = `
      CREATE FUNCTION calculate_accuracy(
        early_double BIGINT UNSIGNED,
        early_single BIGINT UNSIGNED,
        e_perfect BIGINT UNSIGNED,
        perfect BIGINT UNSIGNED,
        l_perfect BIGINT UNSIGNED,
        late_single BIGINT UNSIGNED,
        late_double BIGINT UNSIGNED
      ) RETURNS DOUBLE
      DETERMINISTIC
      BEGIN
        DECLARE total_tiles BIGINT UNSIGNED;
        DECLARE weighted_sum DOUBLE;
        DECLARE result DOUBLE;

        SET total_tiles = early_double + early_single + e_perfect + perfect + l_perfect + late_single + late_double;

        IF total_tiles = 0 THEN
          RETURN NULL;
        END IF;

        SET weighted_sum = perfect +
                          (e_perfect + l_perfect) * 0.75 +
                          (early_single + late_single) * 0.4 +
                          (early_double + late_double) * 0.2;

        SET result = weighted_sum / total_tiles;

        RETURN result;
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

async function createNineArgJudgementAccuracyTriggers(queryInterface) {
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

async function createSevenArgJudgementAccuracyTriggers(queryInterface) {
  await queryInterface.sequelize.query(`
    CREATE TRIGGER update_judgement_accuracy
    BEFORE INSERT ON judgements
    FOR EACH ROW
    BEGIN
      SET NEW.accuracy = calculate_accuracy(
        NEW.earlyDouble,
        NEW.earlySingle,
        NEW.ePerfect,
        NEW.perfect,
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
        NEW.perfect,
        NEW.lPerfect,
        NEW.lateSingle,
        NEW.lateDouble
      );
    END
  `);
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await dropJudgementAccuracyTriggers(queryInterface);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS calculate_accuracy;`);
    await queryInterface.sequelize.query(CALC_ACC_FN_NINE);
    await createNineArgJudgementAccuracyTriggers(queryInterface);

    // Touch only rows that used the extra buckets so the BEFORE/AFTER triggers
    // rewrite judgements.accuracy and copy it onto passes.accuracy (CDC on passes).
    await queryInterface.sequelize.query(`
      UPDATE judgements
      SET accuracy = calculate_accuracy(
        earlyDouble,
        earlySingle,
        ePerfect,
        perfectMinus,
        perfect,
        perfectPlus,
        lPerfect,
        lateSingle,
        lateDouble
      )
      WHERE IFNULL(perfectMinus, 0) > 0 OR IFNULL(perfectPlus, 0) > 0;
    `);
  },

  async down(queryInterface) {
    await dropJudgementAccuracyTriggers(queryInterface);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS calculate_accuracy;`);
    await queryInterface.sequelize.query(CALC_ACC_FN_SEVEN);
    await createSevenArgJudgementAccuracyTriggers(queryInterface);
  },
};
