'use strict';

/** @type {import('sequelize-cli').Migration} */

function parseRatingRange(rating, specialDifficulties) {
  if (specialDifficulties.has(rating.trim())) {
    return [rating.trim()];
  }

  const match = rating.match(/([^-~\s]+|^-\d+)([-~\s])(.+)/);
  if (!match) {
    return [rating.trim()];
  }

  const firstPart = match[1];
  const lastPart = match[3];

  if (specialDifficulties.has(lastPart)) {
    return [firstPart, lastPart];
  }

  const firstMatch = firstPart.match(/([PGUpgu]*)(-?\d+)/);
  const lastMatch = lastPart.match(/([PGUpgu]*)(-?\d+)/);

  if (firstMatch && lastMatch) {
    const firstPrefix = firstMatch[1];
    const lastPrefix = lastMatch[1];
    const lastNum = lastMatch[2];

    if (!lastPrefix && firstPrefix) {
      const rawSecondPart = lastNum;
      if (specialDifficulties.has(rawSecondPart)) {
        return [firstPart, rawSecondPart];
      }
      return [firstPart, `${firstPrefix}${lastNum}`];
    }
  }

  return [firstPart, lastPart];
}

function buildValidPguSortOrderSet(difficultyMap) {
  return new Set(
    Array.from(difficultyMap.values())
      .filter((d) => d.type === 'PGU')
      .map((d) => d.sortOrder),
  );
}

function resolvePartToPguSortOrder(part, difficultyMap, validPguSortOrders) {
  const trimmed = part.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return validPguSortOrders.has(n) ? n : null;
  }

  const match = trimmed.match(/^([PGUpgu]+)(-?\d+)$/i);
  if (!match || !match[1]) return null;
  const normalizedName = `${match[1].toUpperCase()}${match[2]}`;
  const d = difficultyMap.get(normalizedName);
  if (!d || d.type !== 'PGU') return null;
  return d.sortOrder;
}

function collectSpecialsFromParts(parts, specialDifficulties) {
  const names = [];
  for (const p of parts) {
    const t = p.trim();
    if (specialDifficulties.has(t)) names.push(t);
  }
  return names;
}

function getRatingPguNumericAndSpecials(rating, specialDifficulties, difficultyMap) {
  if (!rating || rating.trim() === '') {
    return {specialRatings: [], pguNumeric: null};
  }

  const validPguSortOrders = buildValidPguSortOrderSet(difficultyMap);
  const parts = parseRatingRange(rating.trim(), specialDifficulties);
  const specialRatings = [...new Set(collectSpecialsFromParts(parts, specialDifficulties))];

  if (parts.length === 1) {
    const p = parts[0].trim();
    if (specialDifficulties.has(p)) {
      return {specialRatings, pguNumeric: null};
    }
    const letterMatch = p.match(/^([PGUpgu]+)(-?\d+)$/i);
    if (letterMatch && letterMatch[1]) {
      const normalizedName = `${letterMatch[1].toUpperCase()}${letterMatch[2]}`;
      if (specialDifficulties.has(normalizedName)) {
        return {
          specialRatings: [...new Set([...specialRatings, normalizedName])],
          pguNumeric: null,
        };
      }
    }
    const so = resolvePartToPguSortOrder(p, difficultyMap, validPguSortOrders);
    return {specialRatings, pguNumeric: so};
  }

  if (parts.length !== 2) {
    return {specialRatings, pguNumeric: null};
  }

  const pA = parts[0].trim();
  const pB = parts[1].trim();
  const soA = specialDifficulties.has(pA)
    ? null
    : resolvePartToPguSortOrder(pA, difficultyMap, validPguSortOrders);
  const soB = specialDifficulties.has(pB)
    ? null
    : resolvePartToPguSortOrder(pB, difficultyMap, validPguSortOrders);
  const resolved = [soA, soB].filter((x) => x !== null);

  if (resolved.length === 0) return {specialRatings, pguNumeric: null};
  if (resolved.length === 1) return {specialRatings, pguNumeric: resolved[0]};
  return {specialRatings, pguNumeric: (resolved[0] + resolved[1]) / 2};
}

function pickClosestPguDifficulty(difficultyMap, targetSortOrder) {
  const list = Array.from(difficultyMap.values())
    .filter((d) => d.type === 'PGU')
    .sort((a, b) => {
      const distA = Math.abs(a.sortOrder - targetSortOrder);
      const distB = Math.abs(b.sortOrder - targetSortOrder);
      if (distA !== distB) return distA - distB;
      return b.sortOrder - a.sortOrder;
    });
  return list[0] || null;
}

function calculateAverageDifficulty(details, difficultyMap, specialDifficulties, isCommunity) {
  const voteCounts = new Map();
  let pguNumericSum = 0;
  let pguNumericVoteCount = 0;

  for (const detail of details) {
    if (Boolean(detail.isCommunityRating) !== isCommunity) continue;
    if (!detail.rating) continue;

    const {pguNumeric, specialRatings} = getRatingPguNumericAndSpecials(
      detail.rating,
      specialDifficulties,
      difficultyMap,
    );
    for (const specialRating of specialRatings) {
      const difficulty = difficultyMap.get(specialRating);
      if (!difficulty || difficulty.type !== 'SPECIAL') continue;
      const current = voteCounts.get(specialRating) || {count: 0, difficulty};
      current.count += 1;
      voteCounts.set(specialRating, current);
    }
    if (pguNumeric !== null) {
      pguNumericSum += pguNumeric;
      pguNumericVoteCount += 1;
    }
  }

  const specials = Array.from(voteCounts.entries())
    .filter(([, data]) => data.difficulty.type === 'SPECIAL')
    .sort((a, b) => b[1].count - a[1].count);

  const requiredVotes = isCommunity ? 6 : 4;
  for (const [, data] of specials) {
    if (data.count >= requiredVotes) return data.difficulty;
  }

  if (pguNumericVoteCount > 0) {
    return pickClosestPguDifficulty(difficultyMap, pguNumericSum / pguNumericVoteCount);
  }
  return null;
}

async function tableColumnExists(sequelize, tableName, columnName, transaction) {
  const [rows] = await sequelize.query(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = :tableName
       AND COLUMN_NAME = :columnName`,
    {replacements: {tableName, columnName}, transaction},
  );
  return rows.length > 0;
}

async function indexExists(sequelize, tableName, indexName, transaction) {
  const [rows] = await sequelize.query(
    `SELECT INDEX_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = :tableName
       AND INDEX_NAME = :indexName
     LIMIT 1`,
    {replacements: {tableName, indexName}, transaction},
  );
  return rows.length > 0;
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      const [dupes] = await sequelize.query(
        `SELECT levelId, MAX(id) AS keepId
         FROM ratings
         WHERE confirmedAt IS NULL
         GROUP BY levelId
         HAVING COUNT(*) > 1`,
        {transaction},
      );

      const [difficultyRows] = await sequelize.query(
        `SELECT id, name, type, sortOrder FROM difficulties`,
        {transaction},
      );
      const difficultyMap = new Map(difficultyRows.map((d) => [d.name, d]));
      const specialDifficulties = new Set(
        difficultyRows.filter((d) => d.type === 'SPECIAL').map((d) => d.name),
      );

      for (const dupe of dupes) {
        const keepId = Number(dupe.keepId);
        const levelId = Number(dupe.levelId);
        const [openRows] = await sequelize.query(
          `SELECT id FROM ratings WHERE levelId = :levelId AND confirmedAt IS NULL`,
          {replacements: {levelId}, transaction},
        );
        const discardIds = openRows
          .map((row) => Number(row.id))
          .filter((id) => id !== keepId);
        if (discardIds.length === 0) continue;

        const [keepDetails] = await sequelize.query(
          `SELECT userId FROM rating_details WHERE ratingId = :keepId`,
          {replacements: {keepId}, transaction},
        );
        const claimed = new Set(keepDetails.map((row) => row.userId));

        const [moveCandidates] = await sequelize.query(
          `SELECT id, userId
           FROM rating_details
           WHERE ratingId IN (:discardIds)
           ORDER BY id DESC`,
          {replacements: {discardIds}, transaction},
        );

        for (const row of moveCandidates) {
          if (claimed.has(row.userId)) continue;
          await sequelize.query(
            `UPDATE rating_details SET ratingId = :keepId WHERE id = :id`,
            {replacements: {keepId, id: Number(row.id)}, transaction},
          );
          claimed.add(row.userId);
        }

        await sequelize.query(
          `DELETE FROM ratings WHERE id IN (:discardIds)`,
          {replacements: {discardIds}, transaction},
        );

        const [mergedDetails] = await sequelize.query(
          `SELECT rating, isCommunityRating FROM rating_details WHERE ratingId = :keepId`,
          {replacements: {keepId}, transaction},
        );
        const average = calculateAverageDifficulty(
          mergedDetails,
          difficultyMap,
          specialDifficulties,
          false,
        );
        const community = calculateAverageDifficulty(
          mergedDetails,
          difficultyMap,
          specialDifficulties,
          true,
        );
        await sequelize.query(
          `UPDATE ratings
           SET averageDifficultyId = :averageDifficultyId,
               communityDifficultyId = :communityDifficultyId
           WHERE id = :keepId`,
          {
            replacements: {
              keepId,
              averageDifficultyId: average ? average.id : null,
              communityDifficultyId: community ? community.id : null,
            },
            transaction,
          },
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    // A stored generated column on levelId cannot be added while ratings_ibfk_4
    // is ON DELETE/UPDATE CASCADE (MySQL error 1215). A functional unique index
    // enforces the same "one open rating per level" rule and leaves that FK in place.
    // Confirmed rows store NULL in the index, and MySQL allows many NULLs.
    const hasUnique = await indexExists(
      sequelize,
      'ratings',
      'ratings_one_open_per_level',
    );
    if (!hasUnique) {
      await sequelize.query(
        `ALTER TABLE ratings
           ADD UNIQUE KEY ratings_one_open_per_level ((IF(confirmedAt IS NULL, levelId, NULL)))`,
      );
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const hasUnique = await indexExists(
      sequelize,
      'ratings',
      'ratings_one_open_per_level',
    );
    if (hasUnique) {
      await sequelize.query(
        `ALTER TABLE ratings DROP INDEX ratings_one_open_per_level`,
      );
    }

    const hasOpenLevelId = await tableColumnExists(sequelize, 'ratings', 'openLevelId');
    if (hasOpenLevelId) {
      await sequelize.query(`ALTER TABLE ratings DROP COLUMN openLevelId`);
    }
  },
};
