'use strict';

const {QueryTypes} = require('sequelize');

function mm(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function day(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function pickBoard(boards, since) {
  const usable = boards
    .filter((row) => !Number(row.isGap) && row.geometryId)
    .sort((a, b) => {
      const left = day(a.sinceDate) || '';
      const right = day(b.sinceDate) || '';
      if (left < right) return -1;
      if (left > right) return 1;
      return Number(a.id) - Number(b.id);
    });
  if (!usable.length) return null;
  const target = day(since);
  if (!target) return usable[usable.length - 1];
  const started = usable.filter((row) => {
    const start = day(row.sinceDate);
    return !start || start <= target;
  });
  const pool = started.length ? started : usable;
  return pool[pool.length - 1];
}

function setupFromBoard(board, switches, keys) {
  if (board.sensing === 'membrane') {
    return {
      switches: [],
      keyOverrides: [],
      switchId: null,
      customSwitch: null,
      actuationMm: null,
      rapidTriggerSplit: false,
      rapidTriggerActuationMm: null,
      rapidTriggerPressMm: null,
      rapidTriggerReleaseMm: null,
      stemColor: null,
      baseColor: null,
      topColor: null,
      baseOpacity: null,
    };
  }
  const hall = board.sensing === 'hall';
  const split = Boolean(Number(board.rapidTriggerSplit));
  const list = switches.length
    ? switches
    : [{
      switchId: board.switchId == null ? null : Number(board.switchId),
      customSwitch: board.customSwitch || null,
      stemColor: board.stemColor || null,
      baseColor: board.baseColor || null,
      topColor: board.topColor || null,
      baseOpacity: mm(board.baseOpacity),
    }];
  const indexById = new Map(list.map((row, index) => [Number(row.id), index]));
  return {
    switches: list.map((row) => ({
      switchId: row.switchId == null ? null : Number(row.switchId),
      customSwitch: row.customSwitch || null,
      stemColor: row.stemColor || null,
      baseColor: row.baseColor || null,
      topColor: row.topColor || null,
      baseOpacity: mm(row.baseOpacity),
    })),
    keyOverrides: keys.map((row) => ({
      code: row.keyCode,
      socketEmpty: Boolean(Number(row.socketEmpty)),
      switchId: row.switchId == null ? null : Number(row.switchId),
      customSwitch: row.customSwitch || null,
      periodSwitchIndex: row.periodSwitchId == null
        ? null
        : (indexById.get(Number(row.periodSwitchId)) ?? null),
      actuationMm: mm(row.actuationMm),
      rapidTriggerSplit: hall ? (row.rapidTriggerSplit == null ? null : Boolean(Number(row.rapidTriggerSplit))) : null,
      rapidTriggerActuationMm: hall ? mm(row.rapidTriggerActuationMm) : null,
      rapidTriggerPressMm: hall ? mm(row.rapidTriggerPressMm) : null,
      rapidTriggerReleaseMm: hall ? mm(row.rapidTriggerReleaseMm) : null,
    })),
    switchId: board.switchId == null ? null : Number(board.switchId),
    customSwitch: board.customSwitch || null,
    actuationMm: mm(board.actuationMm),
    rapidTriggerSplit: hall && split,
    rapidTriggerActuationMm: hall && !split ? mm(board.rapidTriggerActuationMm) : null,
    rapidTriggerPressMm: hall && split ? mm(board.rapidTriggerPressMm) : null,
    rapidTriggerReleaseMm: hall && split ? mm(board.rapidTriggerReleaseMm) : null,
    stemColor: board.stemColor || null,
    baseColor: board.baseColor || null,
    topColor: board.topColor || null,
    baseOpacity: mm(board.baseOpacity),
  };
}

/** Each layout period keeps its own switch and actuation copy. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('keyboard_lane_periods');
    if (!table.setupJson) {
      await queryInterface.addColumn('keyboard_lane_periods', 'setupJson', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }
    const sequelize = queryInterface.sequelize;
    const boards = await sequelize.query(
      `SELECT id, rigId, sinceDate, isGap, geometryId, sensing, switchId, customSwitch,
              actuationMm, rapidTriggerSplit, rapidTriggerActuationMm, rapidTriggerPressMm,
              rapidTriggerReleaseMm, stemColor, baseColor, topColor, baseOpacity
         FROM keyboard_board_periods`,
      {type: QueryTypes.SELECT},
    );
    const switches = await sequelize.query(
      `SELECT id, boardPeriodId, sortOrder, switchId, customSwitch, stemColor, baseColor, topColor, baseOpacity
         FROM keyboard_board_period_switches
        ORDER BY sortOrder ASC, id ASC`,
      {type: QueryTypes.SELECT},
    );
    const keys = await sequelize.query(
      `SELECT boardPeriodId, keyCode, socketEmpty, switchId, customSwitch, periodSwitchId,
              actuationMm, rapidTriggerSplit, rapidTriggerActuationMm, rapidTriggerPressMm,
              rapidTriggerReleaseMm
         FROM keyboard_board_period_keys`,
      {type: QueryTypes.SELECT},
    );
    const periods = await sequelize.query(
      `SELECT p.id AS periodId, p.sinceDate, l.rigId
         FROM keyboard_lane_periods p
         JOIN keyboard_lanes l ON l.id = p.laneId
        WHERE p.keysJson IS NOT NULL AND p.setupJson IS NULL`,
      {type: QueryTypes.SELECT},
    );
    const switchesByBoard = new Map();
    for (const row of switches) {
      const list = switchesByBoard.get(row.boardPeriodId) || [];
      list.push(row);
      switchesByBoard.set(row.boardPeriodId, list);
    }
    const keysByBoard = new Map();
    for (const row of keys) {
      const list = keysByBoard.get(row.boardPeriodId) || [];
      list.push(row);
      keysByBoard.set(row.boardPeriodId, list);
    }
    const boardsByRig = new Map();
    for (const row of boards) {
      const list = boardsByRig.get(row.rigId) || [];
      list.push(row);
      boardsByRig.set(row.rigId, list);
    }
    for (const period of periods) {
      const board = pickBoard(boardsByRig.get(period.rigId) || [], period.sinceDate);
      if (!board) continue;
      const setup = setupFromBoard(
        board,
        switchesByBoard.get(board.id) || [],
        keysByBoard.get(board.id) || [],
      );
      await sequelize.query(
        'UPDATE keyboard_lane_periods SET setupJson = CAST(? AS JSON) WHERE id = ? AND setupJson IS NULL',
        {replacements: [JSON.stringify(setup), period.periodId]},
      );
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('keyboard_lane_periods');
    if (table.setupJson) {
      await queryInterface.removeColumn('keyboard_lane_periods', 'setupJson');
    }
  },
};
