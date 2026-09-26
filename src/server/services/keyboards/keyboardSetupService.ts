import {Op, type Transaction} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Player from '@/models/players/Player.js';
import Pass from '@/models/passes/Pass.js';
import {
  KeyboardBoardPeriod,
  KeyboardBoardPeriodKey,
  KeyboardFormFactor,
  KeyboardGeometry,
  KeyboardLane,
  KeyboardLanePeriod,
  KeyboardProduct,
  KeyboardRig,
  KeyboardSwitch,
  PassBindOverride,
} from '@/models/keyboards/index.js';
import {
  KEYBOARD_SWITCH_STEMS,
  KeyboardSetupError,
  MAX_KEY_COUNT,
  MAX_KEYBOARD_NAME_LENGTH,
  MAX_KEYBOARD_RIGS_PER_PLAYER,
  MAX_LANES_PER_RIG,
  MAX_PERIODS_PER_LIST,
  MAX_RIG_NAME_LENGTH,
  PASS_UPLOAD_SENTINEL_ISO,
  assertUniqueSinceDates,
  canonicalizeKeys,
  currentPeriod,
  emptySocketCodes,
  findPeriodAt,
  keySignature,
  parseBoardSpecInput,
  parseKeysArray,
  parseSinceDate,
  playerHasKeyboardsModule,
  sortTimelinePeriods,
  utcDateFromInstant,
  assertRangeGroup,
  isUntilAuto,
  periodCoversDate,
  type BoardSpecInput,
  type KeyboardSwitchStem,
  type StoredGeometryKey,
} from '@/misc/utils/keyboards/index.js';
import {getPieceForEntity} from '@/server/services/profileCustomization/ProfileCustomizationService.js';
import ProfileCustomizationPiece from '@/models/profile/ProfileCustomizationPiece.js';

const sequelize = getSequelizeForModelGroup('players');

const RIG_INCLUDE = [
  {
    model: KeyboardBoardPeriod,
    as: 'boardPeriods',
    include: [
      {model: KeyboardGeometry, as: 'geometry'},
      {model: KeyboardProduct, as: 'product'},
      {model: KeyboardSwitch, as: 'switch'},
      {model: KeyboardBoardPeriodKey, as: 'keyOverrides'},
    ],
  },
  {
    model: KeyboardLane,
    as: 'lanes',
    include: [{model: KeyboardLanePeriod, as: 'periods'}],
  },
];

function mm(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sinceKey(value: string | Date | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function parseStoredKeys(raw: unknown): StoredGeometryKey[] {
  return Array.isArray(raw) ? (raw as StoredGeometryKey[]) : [];
}

function bindableCodeSet(keys: StoredGeometryKey[]): Set<string> {
  return new Set(keys.filter((key) => key.bindable).map((key) => key.code));
}

function serializeFormFactor(row: KeyboardFormFactor) {
  return {
    slug: row.slug,
    name: row.name,
    note: row.note,
    sortOrder: Number(row.sortOrder),
  };
}

function serializeGeometry(row: KeyboardGeometry) {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    formFactor: row.formFactor,
    keys: parseStoredKeys(row.keysJson),
  };
}

function serializeProduct(row: KeyboardProduct) {
  return {
    id: Number(row.id),
    geometryId: row.geometryId,
    brand: row.brand,
    model: row.model,
  };
}

function serializeSwitch(row: KeyboardSwitch) {
  return {
    id: Number(row.id),
    name: row.name,
    sensing: row.sensing,
    stem: row.stem,
    baseColor: row.baseColor,
    topColor: row.topColor,
    stemColor: row.stemColor,
    baseOpacity: row.baseOpacity == null ? null : Number(row.baseOpacity),
  };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseSwitchStem(raw: unknown): KeyboardSwitchStem | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !KEYBOARD_SWITCH_STEMS.includes(raw as KeyboardSwitchStem)) {
    throw new KeyboardSetupError(400, 'Invalid switch stem');
  }
  return raw as KeyboardSwitchStem;
}

function parseSwitchColor(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !HEX_COLOR.test(raw)) {
    throw new KeyboardSetupError(400, 'Color must be a #RRGGBB value');
  }
  return raw.toLowerCase();
}

function parseBaseOpacity(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new KeyboardSetupError(400, 'Base opacity must be between 0 and 1');
  }
  return Math.round(n * 100) / 100;
}

function serializeBoardPeriod(row: KeyboardBoardPeriod & {
  geometry?: KeyboardGeometry | null;
  product?: KeyboardProduct | null;
  switch?: KeyboardSwitch | null;
  keyOverrides?: KeyboardBoardPeriodKey[];
}) {
  return {
    id: Number(row.id),
    sinceDate: sinceKey(row.sinceDate),
    untilDate: sinceKey(row.untilDate),
    untilAuto: row.untilAuto !== false,
    isGap: Boolean(row.isGap),
    geometryId: row.geometryId,
    productId: row.productId,
    customBrand: row.customBrand,
    customModel: row.customModel,
    sensing: row.sensing,
    switchId: row.switchId,
    customSwitch: row.customSwitch,
    actuationMm: mm(row.actuationMm),
    rapidTriggerSplit: Boolean(row.rapidTriggerSplit),
    rapidTriggerActuationMm: mm(row.rapidTriggerActuationMm),
    rapidTriggerPressMm: mm(row.rapidTriggerPressMm),
    rapidTriggerReleaseMm: mm(row.rapidTriggerReleaseMm),
    colorway: row.colorway,
    note: row.note,
    stemColor: row.stemColor,
    baseColor: row.baseColor,
    topColor: row.topColor,
    geometry: row.geometry ? serializeGeometry(row.geometry) : null,
    product: row.product ? serializeProduct(row.product) : null,
    switch: row.switch ? serializeSwitch(row.switch) : null,
    keyOverrides: (row.keyOverrides ?? []).map((item) => ({
      code: item.keyCode,
      socketEmpty: Boolean(item.socketEmpty),
      switchId: item.switchId,
      customSwitch: item.customSwitch,
    })),
  };
}

function serializeLanePeriod(row: KeyboardLanePeriod) {
  return {
    id: Number(row.id),
    sinceDate: sinceKey(row.sinceDate),
    untilDate: sinceKey(row.untilDate),
    untilAuto: row.untilAuto !== false,
    keys: row.keysJson,
    keySignature: row.keySignature,
    isGap: row.keysJson == null,
  };
}

function serializeRig(row: KeyboardRig & {
  boardPeriods?: KeyboardBoardPeriod[];
  lanes?: Array<KeyboardLane & {periods?: KeyboardLanePeriod[]}>;
}) {
  return {
    id: Number(row.id),
    name: row.name,
    sortOrder: Number(row.sortOrder),
    boardPeriods: sortTimelinePeriods(row.boardPeriods ?? []).map((period) =>
      serializeBoardPeriod(period as KeyboardBoardPeriod & {
        geometry?: KeyboardGeometry | null;
        product?: KeyboardProduct | null;
        switch?: KeyboardSwitch | null;
        keyOverrides?: KeyboardBoardPeriodKey[];
      }),
    ),
    lanes: [...(row.lanes ?? [])]
      .sort((a, b) => a.id - b.id)
      .map((lane) => ({
        id: Number(lane.id),
        keyCount: lane.keyCount,
        name: lane.name || `${lane.keyCount}K`,
        periods: sortTimelinePeriods(lane.periods ?? []).map(serializeLanePeriod),
      })),
  };
}

async function playerModuleOn(playerId: number): Promise<boolean> {
  const piece = await getPieceForEntity('player', playerId, 'profile_modules');
  return playerHasKeyboardsModule(piece?.payload ?? null);
}

async function loadRigs(playerId: number) {
  return KeyboardRig.findAll({
    where: {playerId},
    include: RIG_INCLUDE,
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });
}

export async function getKeyboardCatalog() {
  const [geometries, products, switches, formFactors] = await Promise.all([
    KeyboardGeometry.findAll({order: [['id', 'ASC']]}),
    KeyboardProduct.findAll({order: [['brand', 'ASC'], ['model', 'ASC']]}),
    KeyboardSwitch.findAll({order: [['name', 'ASC']]}),
    KeyboardFormFactor.findAll({order: [['sortOrder', 'ASC'], ['name', 'ASC']]}),
  ]);
  return {
    geometries: geometries.map(serializeGeometry),
    products: products.map(serializeProduct),
    switches: switches.map(serializeSwitch),
    formFactors: formFactors.map(serializeFormFactor),
  };
}

export async function getPlayerKeyboardSetups(playerId: number, {visibleOnly = true} = {}) {
  if (visibleOnly) {
    const visible = await playerModuleOn(playerId);
    if (!visible) {
      return {visible: false, rigs: [] as ReturnType<typeof serializeRig>[]};
    }
  }
  const rigs = await loadRigs(playerId);
  return {visible: true, rigs: rigs.map((rig) => serializeRig(rig as never))};
}

function parseOptionalPeriodId(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new KeyboardSetupError(400, 'Invalid period');
  }
  return id;
}

function parseOptionalName(raw: unknown, max: number): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new KeyboardSetupError(400, 'Name must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    throw new KeyboardSetupError(400, `Name must be at most ${max} characters`);
  }
  return trimmed || null;
}

const COUNT_LAYOUT_NAME = /^[0-9]+K$/;

function layoutNameFor(raw: unknown, keyCount: number): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || COUNT_LAYOUT_NAME.test(trimmed)) return `${keyCount}K`;
  if (trimmed.length > 32) {
    throw new KeyboardSetupError(400, 'Layout name must be at most 32 characters');
  }
  return trimmed;
}

function parseKeyCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_KEY_COUNT) {
    throw new KeyboardSetupError(400, `keyCount must be an integer from 1 to ${MAX_KEY_COUNT}`);
  }
  return n;
}

async function assertGeometry(id: number, transaction?: Transaction) {
  const geo = await KeyboardGeometry.findByPk(id, {transaction});
  if (!geo) throw new KeyboardSetupError(400, 'Unknown geometry');
  return geo;
}

async function assertProduct(id: number | null | undefined, geometryId: number, transaction?: Transaction) {
  if (id == null) return null;
  const product = await KeyboardProduct.findByPk(id, {transaction});
  if (!product) throw new KeyboardSetupError(400, 'Unknown keyboard product');
  if (product.geometryId !== geometryId) {
    throw new KeyboardSetupError(400, 'Product does not match the selected board shape');
  }
  return product;
}

async function assertSwitch(id: number | null | undefined, transaction?: Transaction) {
  if (id == null) return null;
  const row = await KeyboardSwitch.findByPk(id, {transaction});
  if (!row) throw new KeyboardSetupError(400, 'Unknown switch');
  return row;
}

function assertKeysOnBoard(
  keys: string[],
  geometry: KeyboardGeometry,
  spec: BoardSpecInput,
) {
  const bindable = bindableCodeSet(parseStoredKeys(geometry.keysJson));
  const empty = emptySocketCodes(spec);
  for (const code of keys) {
    if (!bindable.has(code)) {
      throw new KeyboardSetupError(400, `Key ${code} is not on this board`);
    }
    if (empty.has(code)) {
      throw new KeyboardSetupError(400, `Key ${code} is an empty socket and cannot be bound`);
    }
  }
}

async function replaceKeyOverrides(
  boardPeriodId: number,
  spec: BoardSpecInput,
  transaction: Transaction,
) {
  await KeyboardBoardPeriodKey.destroy({where: {boardPeriodId}, transaction});
  const rows = (spec.keyOverrides ?? []).map((row) => ({
    boardPeriodId,
    keyCode: row.code,
    socketEmpty: Boolean(row.socketEmpty),
    switchId: row.switchId ?? null,
    customSwitch: row.customSwitch ?? null,
  }));
  if (rows.length) {
    await KeyboardBoardPeriodKey.bulkCreate(rows, {transaction});
  }
}

function coveringBoardPeriod(
  boardPeriods: KeyboardBoardPeriod[],
  sinceDate: string | null,
): KeyboardBoardPeriod | null {
  const list = sortTimelinePeriods(boardPeriods);
  if (sinceDate == null) return list[0] ?? null;
  return findPeriodAt(list, sinceDate);
}

function parseUntilFields(
  rec: Record<string, unknown>,
  sinceDate: string | null,
): {untilDate: string | null; untilAuto: boolean} {
  if (!('untilDate' in rec) && !('untilAuto' in rec)) {
    return {untilDate: null, untilAuto: true};
  }
  const untilAuto = rec.untilAuto == null
    ? rec.untilDate == null || rec.untilDate === ''
    : Boolean(rec.untilAuto);
  if (untilAuto) return {untilDate: null, untilAuto: true};
  const untilDate = parseSinceDate(rec.untilDate, {allowNull: false});
  if (sinceDate && untilDate && untilDate <= sinceDate) {
    throw new KeyboardSetupError(400, 'untilDate must be after sinceDate');
  }
  return {untilDate, untilAuto: false};
}

function asRangePeriod(row: {
  id?: number;
  sinceDate: string | Date | null;
  untilDate?: string | Date | null;
  untilAuto?: boolean;
  isGap?: boolean;
}) {
  return {
    id: row.id ?? 0,
    sinceDate: sinceKey(row.sinceDate),
    untilDate: sinceKey(row.untilDate ?? null),
    untilAuto: isUntilAuto(row),
    isGap: Boolean(row.isGap),
  };
}

export async function createRig(playerId: number, raw: {name?: unknown} = {}) {
  const count = await KeyboardRig.count({where: {playerId}});
  if (count >= MAX_KEYBOARD_RIGS_PER_PLAYER) {
    throw new KeyboardSetupError(400, `At most ${MAX_KEYBOARD_RIGS_PER_PLAYER} rigs per player`);
  }
  const maxSort = await KeyboardRig.max('sortOrder', {where: {playerId}});
  const rig = await KeyboardRig.create({
    playerId,
    name: parseOptionalName(raw.name, MAX_RIG_NAME_LENGTH),
    sortOrder: (typeof maxSort === 'number' ? maxSort : 0) + 1,
  });
  const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE});
  return serializeRig(loaded as never);
}

export async function updateRig(
  playerId: number,
  rigId: number,
  raw: {name?: unknown; sortOrder?: unknown},
) {
  const rig = await KeyboardRig.findOne({where: {id: rigId, playerId}});
  if (!rig) throw new KeyboardSetupError(404, 'Rig not found');
  const patch: {name?: string | null; sortOrder?: number} = {};
  if ('name' in raw) patch.name = parseOptionalName(raw.name, MAX_RIG_NAME_LENGTH);
  if ('sortOrder' in raw) {
    const n = Number(raw.sortOrder);
    if (!Number.isInteger(n)) throw new KeyboardSetupError(400, 'sortOrder must be an integer');
    patch.sortOrder = n;
  }
  await rig.update(patch);
  const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE});
  return serializeRig(loaded as never);
}

export async function deleteRig(playerId: number, rigId: number) {
  const rig = await KeyboardRig.findOne({where: {id: rigId, playerId}});
  if (!rig) throw new KeyboardSetupError(404, 'Rig not found');
  await rig.destroy();
  return {ok: true};
}

type SnapshotBoard = {
  sinceDate: string | null;
  untilDate: string | null;
  untilAuto: boolean;
  isGap: boolean;
  spec: BoardSpecInput | null;
};

type SnapshotLanePeriod = {
  sinceDate: string | null;
  untilDate: string | null;
  untilAuto: boolean;
  keys: string[] | null;
};

type RigSnapshot = {
  name: string | null;
  boards: SnapshotBoard[];
  lanes: {name: string | null; periods: SnapshotLanePeriod[]}[];
};

function parseRigSnapshot(raw: unknown): RigSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KeyboardSetupError(400, 'Invalid keyboard snapshot');
  }
  const body = raw as Record<string, unknown>;
  if (body.kind !== 'tuf.keyboard-rig' || body.version !== 1) {
    throw new KeyboardSetupError(400, 'Unrecognized keyboard snapshot');
  }
  const boardsRaw = Array.isArray(body.boardPeriods) ? body.boardPeriods : [];
  const lanesRaw = Array.isArray(body.lanes) ? body.lanes : [];
  if (boardsRaw.length > MAX_PERIODS_PER_LIST) {
    throw new KeyboardSetupError(400, `At most ${MAX_PERIODS_PER_LIST} board periods per rig`);
  }
  if (lanesRaw.length > MAX_LANES_PER_RIG) {
    throw new KeyboardSetupError(400, `At most ${MAX_LANES_PER_RIG} layouts per rig`);
  }
  const boards: SnapshotBoard[] = boardsRaw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new KeyboardSetupError(400, 'Invalid board period');
    }
    const rec = item as Record<string, unknown>;
    const sinceDate = parseSinceDate(rec.sinceDate);
    const until = parseUntilFields(rec, sinceDate);
    if (rec.isGap) return {sinceDate, ...until, isGap: true, spec: null};
    const specInput = Array.isArray(rec.keyOverrides) ? rec : {...rec, keyOverrides: []};
    return {sinceDate, ...until, isGap: false, spec: parseBoardSpecInput(specInput)};
  });
  const lanes = lanesRaw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new KeyboardSetupError(400, 'Invalid layout');
    }
    const rec = item as Record<string, unknown>;
    const periodsRaw = Array.isArray(rec.periods) ? rec.periods : [];
    if (periodsRaw.length > MAX_PERIODS_PER_LIST) {
      throw new KeyboardSetupError(400, `At most ${MAX_PERIODS_PER_LIST} periods per layout`);
    }
    const periods: SnapshotLanePeriod[] = periodsRaw.map((period) => {
      if (!period || typeof period !== 'object' || Array.isArray(period)) {
        throw new KeyboardSetupError(400, 'Invalid layout period');
      }
      const row = period as Record<string, unknown>;
      const keys = row.keys == null ? null : parseKeysArray(row.keys);
      const sinceDate = parseSinceDate(row.sinceDate);
      return {sinceDate, ...parseUntilFields(row, sinceDate), keys: keys && keys.length ? keys : null};
    });
    const named = typeof rec.name === 'string' ? rec.name : null;
    return {name: named, periods};
  });
  return {name: parseOptionalName(body.name, MAX_RIG_NAME_LENGTH), boards, lanes};
}

async function writeSnapshot(rig: KeyboardRig, snapshot: RigSnapshot, transaction: Transaction) {
  for (const board of snapshot.boards) {
    await writeBoardPeriod({
      rig,
      sinceDate: board.sinceDate,
      untilDate: board.untilDate,
      untilAuto: board.untilAuto,
      isGap: board.isGap,
      spec: board.spec,
      transaction,
    });
  }
  const boardPeriods = await KeyboardBoardPeriod.findAll({where: {rigId: rig.id}, transaction});
  let written = 0;
  for (const laneSnap of snapshot.lanes) {
    const keyed = laneSnap.periods.filter((period) => period.keys && period.keys.length);
    if (!keyed.length) continue;
    if (written >= MAX_LANES_PER_RIG) {
      throw new KeyboardSetupError(400, `At most ${MAX_LANES_PER_RIG} layouts per rig`);
    }
    const latestKeys = keyed[keyed.length - 1]?.keys;
    if (!latestKeys?.length) continue;
    const keyCount = latestKeys.length;
    const name = layoutNameFor(laneSnap.name, keyCount);
    const lane = await KeyboardLane.create({rigId: rig.id, keyCount, name}, {transaction});
    written += 1;
    for (const period of laneSnap.periods) {
      const keys = period.keys;
      if (keys && keys.length && keys.length !== lane.keyCount) {
        await lane.update({keyCount: keys.length}, {transaction});
      }
      await writeLanePeriod({
        lane,
        sinceDate: period.sinceDate,
        untilDate: period.untilDate,
        untilAuto: period.untilAuto,
        keys,
        boardPeriods,
        transaction,
      });
    }
    if (lane.keyCount !== keyCount) {
      await lane.update({keyCount, name}, {transaction});
    }
  }
}

export async function importRigSnapshot(
  playerId: number,
  raw: {mode?: unknown; rigId?: unknown; snapshot?: unknown},
) {
  const mode = raw.mode === 'replace' || raw.mode === 'duplicate' ? raw.mode : null;
  if (!mode) throw new KeyboardSetupError(400, 'mode must be duplicate or replace');
  const snapshot = parseRigSnapshot(raw.snapshot);
  return sequelize.transaction(async (transaction) => {
    let rig: KeyboardRig;
    if (mode === 'duplicate') {
      const count = await KeyboardRig.count({where: {playerId}, transaction});
      if (count >= MAX_KEYBOARD_RIGS_PER_PLAYER) {
        throw new KeyboardSetupError(400, `At most ${MAX_KEYBOARD_RIGS_PER_PLAYER} rigs per player`);
      }
      const maxSort = await KeyboardRig.max('sortOrder', {where: {playerId}, transaction});
      rig = await KeyboardRig.create(
        {
          playerId,
          name: snapshot.name,
          sortOrder: (typeof maxSort === 'number' ? maxSort : 0) + 1,
        },
        {transaction},
      );
    } else {
      const rigId = Number(raw.rigId);
      if (!Number.isInteger(rigId) || rigId <= 0) {
        throw new KeyboardSetupError(400, 'rigId is required');
      }
      const existing = await KeyboardRig.findOne({where: {id: rigId, playerId}, transaction});
      if (!existing) throw new KeyboardSetupError(404, 'Rig not found');
      await KeyboardLane.destroy({where: {rigId: existing.id}, transaction});
      await KeyboardBoardPeriod.destroy({where: {rigId: existing.id}, transaction});
      await existing.update({name: snapshot.name}, {transaction});
      rig = existing;
    }
    await writeSnapshot(rig, snapshot, transaction);
    const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE, transaction});
    return serializeRig(loaded as never);
  });
}

async function writeBoardPeriod(opts: {
  rig: KeyboardRig;
  periodId?: number;
  sinceDate: string | null;
  untilDate: string | null;
  untilAuto: boolean;
  isGap: boolean;
  spec: BoardSpecInput | null;
  transaction: Transaction;
}) {
  const {rig, periodId, sinceDate, untilDate, untilAuto, isGap, spec, transaction} = opts;
  const existing = await KeyboardBoardPeriod.findAll({where: {rigId: rig.id}, transaction});
  const match = periodId
    ? existing.find((item) => item.id === periodId)
    : existing.find((item) => sinceKey(item.sinceDate) === sinceKey(sinceDate));
  if (periodId && !match) {
    throw new KeyboardSetupError(404, 'Board period not found');
  }
  const others = existing.filter((row) => row.id !== match?.id);
  assertUniqueSinceDates([...others.map((row) => ({sinceDate: sinceKey(row.sinceDate)})), {sinceDate}]);
  if (others.length + 1 > MAX_PERIODS_PER_LIST) {
    throw new KeyboardSetupError(400, `At most ${MAX_PERIODS_PER_LIST} board periods per rig`);
  }
  assertRangeGroup([
    ...others.map((row) => asRangePeriod({
      id: row.id,
      sinceDate: row.sinceDate,
      untilDate: row.untilDate,
      untilAuto: row.untilAuto,
      isGap: row.isGap,
    })),
    asRangePeriod({id: match?.id ?? 0, sinceDate, untilDate, untilAuto, isGap}),
  ]);

  let geometryId: number | null = null;
  let productId: number | null = null;
  let switchId: number | null = null;
  let readySpec: BoardSpecInput | null = spec;
  if (!isGap) {
    if (!spec) throw new KeyboardSetupError(400, 'Board spec is required');
    const geo = await assertGeometry(spec.geometryId, transaction);
    await assertProduct(spec.productId, geo.id, transaction);
    await assertSwitch(spec.switchId, transaction);
    for (const row of spec.keyOverrides ?? []) {
      await assertSwitch(row.switchId, transaction);
    }
    geometryId = geo.id;
    productId = spec.productId ?? null;
    switchId = spec.switchId ?? null;
    readySpec = spec;
  }

  const payload = {
    rigId: rig.id,
    sinceDate,
    untilDate,
    untilAuto,
    isGap,
    geometryId,
    productId,
    customBrand: readySpec?.customBrand ?? null,
    customModel: readySpec?.customModel ?? null,
    sensing: readySpec?.sensing ?? null,
    switchId,
    customSwitch: readySpec?.customSwitch ?? null,
    actuationMm: readySpec?.actuationMm ?? null,
    rapidTriggerSplit: Boolean(readySpec?.rapidTriggerSplit),
    rapidTriggerActuationMm: readySpec?.rapidTriggerActuationMm ?? null,
    rapidTriggerPressMm: readySpec?.rapidTriggerPressMm ?? null,
    rapidTriggerReleaseMm: readySpec?.rapidTriggerReleaseMm ?? null,
    colorway: readySpec?.colorway ?? null,
    note: readySpec?.note ?? null,
    stemColor: readySpec?.stemColor ?? null,
    baseColor: readySpec?.baseColor ?? null,
    topColor: readySpec?.topColor ?? null,
  };

  let row: KeyboardBoardPeriod;
  if (match) {
    await match.update(payload, {transaction});
    row = match;
  } else {
    row = await KeyboardBoardPeriod.create(payload, {transaction});
  }
  await replaceKeyOverrides(row.id, readySpec ?? {geometryId: 0, keyOverrides: []}, transaction);
  return row;
}

async function writeLanePeriod(opts: {
  lane: KeyboardLane;
  periodId?: number;
  sinceDate: string | null;
  untilDate: string | null;
  untilAuto: boolean;
  keys: string[] | null;
  boardPeriods: KeyboardBoardPeriod[];
  transaction: Transaction;
}) {
  const {lane, periodId, sinceDate, untilDate, untilAuto, keys, boardPeriods, transaction} = opts;
  const existing = await KeyboardLanePeriod.findAll({where: {laneId: lane.id}, transaction});
  const match = periodId
    ? existing.find((item) => item.id === periodId)
    : existing.find((item) => sinceKey(item.sinceDate) === sinceKey(sinceDate));
  if (periodId && !match) {
    throw new KeyboardSetupError(404, 'Lane period not found');
  }
  const others = existing.filter((row) => row.id !== match?.id);
  assertUniqueSinceDates([...others.map((row) => ({sinceDate: sinceKey(row.sinceDate)})), {sinceDate}]);
  if (others.length + 1 > MAX_PERIODS_PER_LIST) {
    throw new KeyboardSetupError(400, `At most ${MAX_PERIODS_PER_LIST} periods per key count`);
  }

  let keysJson: string[] | null = null;
  let signature: string | null = null;
  if (keys != null) {
    if (canonicalizeKeys(keys).length !== lane.keyCount) {
      throw new KeyboardSetupError(400, `This lane requires exactly ${lane.keyCount} keys`);
    }
    const covering = coveringBoardPeriod(boardPeriods, sinceDate);
    const board = covering && !covering.isGap
      ? covering
      : sortTimelinePeriods(boardPeriods).filter((period) => !period.isGap && period.geometryId).at(-1) ?? null;
    if (!board || board.isGap || !board.geometryId) {
      throw new KeyboardSetupError(400, 'Cannot bind keys while this rig has no board');
    }
    const geometry = await assertGeometry(board.geometryId, transaction);
    const spec = parseBoardSpecInput({
      geometryId: board.geometryId,
      keyOverrides: (
        await KeyboardBoardPeriodKey.findAll({where: {boardPeriodId: board.id}, transaction})
      ).map((row) => ({
        code: row.keyCode,
        socketEmpty: row.socketEmpty,
        switchId: row.switchId,
        customSwitch: row.customSwitch,
      })),
    });
    assertKeysOnBoard(keys, geometry, spec);
    keysJson = canonicalizeKeys(keys);
    signature = keySignature(keysJson);
  }

  if (keysJson) {
    const count = keysJson.length;
    const siblings = await KeyboardLane.findAll({
      where: {rigId: lane.rigId},
      include: [{model: KeyboardLanePeriod, as: 'periods'}],
      transaction,
    });
    const fitting = siblings.flatMap((item) =>
      ((item as KeyboardLane & {periods?: KeyboardLanePeriod[]}).periods ?? [])
        .filter((period) => period.id !== match?.id && period.keysJson?.length === count)
        .map((period) => asRangePeriod({
          id: period.id,
          sinceDate: period.sinceDate,
          untilDate: period.untilDate,
          untilAuto: period.untilAuto,
        })),
    );
    assertRangeGroup([
      ...fitting,
      asRangePeriod({id: match?.id ?? 0, sinceDate, untilDate, untilAuto}),
    ]);
  }

  const payload = {laneId: lane.id, sinceDate, untilDate, untilAuto, keysJson, keySignature: signature};
  if (match) {
    await match.update(payload, {transaction});
    return match;
  }
  return KeyboardLanePeriod.create(payload, {transaction});
}

export async function saveRigRevision(
  playerId: number,
  rigId: number,
  raw: Record<string, unknown>,
) {
  const rig = await KeyboardRig.findOne({where: {id: rigId, playerId}});
  if (!rig) throw new KeyboardSetupError(404, 'Rig not found');
  const sinceDate = parseSinceDate(raw.sinceDate);
  const boardUntil = parseUntilFields(raw, sinceDate);
  const isGap = Boolean(raw.isGap);
  const skipBoard = Boolean(raw.skipBoard);
  const spec = isGap || skipBoard ? null : parseBoardSpecInput(raw.board ?? raw);
  const lanesRaw = Array.isArray(raw.lanes) ? raw.lanes : [];
  const boardPeriodId = parseOptionalPeriodId(raw.boardPeriodId);

  return sequelize.transaction(async (transaction) => {
    if ('name' in raw) {
      await rig.update({name: parseOptionalName(raw.name, MAX_RIG_NAME_LENGTH)}, {transaction});
    }
    if (!skipBoard) {
      await writeBoardPeriod({
        rig,
        periodId: boardPeriodId,
        sinceDate,
        untilDate: boardUntil.untilDate,
        untilAuto: boardUntil.untilAuto,
        isGap,
        spec,
        transaction,
      });
    }
    const boardPeriods = await KeyboardBoardPeriod.findAll({where: {rigId: rig.id}, transaction});
    for (const item of lanesRaw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new KeyboardSetupError(400, 'Invalid lane revision');
      }
      const rec = item as Record<string, unknown>;
      const keyCount = parseKeyCount(rec.keyCount);
      const name = layoutNameFor(rec.name, keyCount);
      const requestedId = rec.id == null || rec.id === '' ? null : Number(rec.id);
      let lane: KeyboardLane | null = null;
      if (requestedId != null) {
        if (!Number.isInteger(requestedId)) {
          throw new KeyboardSetupError(400, 'Invalid layout');
        }
        lane = await KeyboardLane.findOne({where: {id: requestedId, rigId: rig.id}, transaction});
        if (!lane) throw new KeyboardSetupError(400, 'Unknown layout');
        await lane.update({keyCount, name}, {transaction});
      } else {
        const laneCount = await KeyboardLane.count({where: {rigId: rig.id}, transaction});
        if (laneCount >= MAX_LANES_PER_RIG) {
          throw new KeyboardSetupError(400, `At most ${MAX_LANES_PER_RIG} layouts per rig`);
        }
        lane = await KeyboardLane.create({rigId: rig.id, keyCount, name}, {transaction});
      }
      const keys =
        rec.keys == null ? null : parseKeysArray(rec.keys);
      const laneSince = 'sinceDate' in rec ? parseSinceDate(rec.sinceDate) : sinceDate;
      const laneUntil = parseUntilFields(rec, laneSince);
      await writeLanePeriod({
        lane,
        periodId: parseOptionalPeriodId(rec.periodId),
        sinceDate: laneSince,
        untilDate: laneUntil.untilDate,
        untilAuto: laneUntil.untilAuto,
        keys,
        boardPeriods,
        transaction,
      });
    }
    const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE, transaction});
    return serializeRig(loaded as never);
  });
}

export async function upsertBoardPeriod(
  playerId: number,
  rigId: number,
  raw: Record<string, unknown>,
  periodId?: number,
) {
  const rig = await KeyboardRig.findOne({where: {id: rigId, playerId}});
  if (!rig) throw new KeyboardSetupError(404, 'Rig not found');
  const sinceDate = parseSinceDate(raw.sinceDate);
  const until = parseUntilFields(raw, sinceDate);
  const isGap = Boolean(raw.isGap);
  const spec = isGap ? null : parseBoardSpecInput(raw);
  await sequelize.transaction(async (transaction) => {
    await writeBoardPeriod({
      rig,
      periodId,
      sinceDate,
      untilDate: until.untilDate,
      untilAuto: until.untilAuto,
      isGap,
      spec,
      transaction,
    });
  });
  const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE});
  return serializeRig(loaded as never);
}

export async function deleteBoardPeriod(playerId: number, periodId: number) {
  const row = await KeyboardBoardPeriod.findByPk(periodId, {
    include: [{model: KeyboardRig, as: 'rig'}],
  });
  const rig = (row as KeyboardBoardPeriod & {rig?: KeyboardRig} | null)?.rig;
  if (!row || !rig || rig.playerId !== playerId) {
    throw new KeyboardSetupError(404, 'Board period not found');
  }
  await row.destroy();
  const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE});
  return serializeRig(loaded as never);
}

export async function upsertLanePeriod(
  playerId: number,
  laneId: number,
  raw: Record<string, unknown>,
  periodId?: number,
) {
  const lane = await KeyboardLane.findByPk(laneId, {
    include: [{model: KeyboardRig, as: 'rig'}],
  });
  const rig = (lane as KeyboardLane & {rig?: KeyboardRig} | null)?.rig;
  if (!lane || !rig || rig.playerId !== playerId) {
    throw new KeyboardSetupError(404, 'Lane not found');
  }
  const sinceDate = parseSinceDate(raw.sinceDate);
  const until = parseUntilFields(raw, sinceDate);
  const keys = raw.keys == null ? null : parseKeysArray(raw.keys);
  await sequelize.transaction(async (transaction) => {
    const boardPeriods = await KeyboardBoardPeriod.findAll({where: {rigId: rig.id}, transaction});
    await writeLanePeriod({
      lane,
      periodId,
      sinceDate,
      untilDate: until.untilDate,
      untilAuto: until.untilAuto,
      keys,
      boardPeriods,
      transaction,
    });
  });
  const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE});
  return serializeRig(loaded as never);
}

export async function deleteLanePeriod(playerId: number, periodId: number) {
  const row = await KeyboardLanePeriod.findByPk(periodId, {
    include: [{model: KeyboardLane, as: 'lane', include: [{model: KeyboardRig, as: 'rig'}]}],
  });
  const lane = (row as KeyboardLanePeriod & {lane?: KeyboardLane & {rig?: KeyboardRig}} | null)?.lane;
  const rig = lane?.rig;
  if (!row || !rig || rig.playerId !== playerId) {
    throw new KeyboardSetupError(404, 'Lane period not found');
  }
  await row.destroy();
  const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE});
  return serializeRig(loaded as never);
}

export async function deleteLane(playerId: number, laneId: number) {
  const lane = await KeyboardLane.findByPk(laneId, {
    include: [{model: KeyboardRig, as: 'rig'}],
  });
  const rig = (lane as KeyboardLane & {rig?: KeyboardRig} | null)?.rig;
  if (!lane || !rig || rig.playerId !== playerId) {
    throw new KeyboardSetupError(404, 'Lane not found');
  }
  await lane.destroy();
  const loaded = await KeyboardRig.findByPk(rig.id, {include: RIG_INCLUDE});
  return serializeRig(loaded as never);
}

export type CurrentKeybindRow = {
  playerId: number;
  playerName: string;
  rigId: number;
  keyCount: number;
  keys: string[];
  signature: string;
  geometrySlug: string | null;
  formFactor: string | null;
  productName: string | null;
  sensing: string | null;
  switchName: string | null;
  actuationMm: number | null;
  rapidTriggerSplit: boolean;
  rapidTriggerActuationMm: number | null;
  rapidTriggerPressMm: number | null;
  rapidTriggerReleaseMm: number | null;
};

export async function listCurrentKeybinds(opts: {
  limit?: number;
  offset?: number;
  formFactor?: string;
  keyCount?: number;
}) {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const rigs = await KeyboardRig.findAll({
    include: [
      ...RIG_INCLUDE,
      {model: Player, as: 'player', attributes: ['id', 'name']},
    ],
  });

  const playerIds = [...new Set(rigs.map((rig) => rig.playerId))];
  const pieces = playerIds.length
    ? await ProfileCustomizationPiece.findAll({
        where: {unit: 'profile_modules', playerId: {[Op.in]: playerIds}},
      })
    : [];
  const visiblePlayerIds = new Set(
    pieces
      .filter((piece) => piece.playerId != null && playerHasKeyboardsModule(piece.payload))
      .map((piece) => piece.playerId as number),
  );

  const rows: CurrentKeybindRow[] = [];
  for (const rig of rigs) {
    if (!visiblePlayerIds.has(rig.playerId)) continue;
    const player = (rig as KeyboardRig & {player?: Player}).player;
    const board = currentPeriod(
      ((rig as KeyboardRig & {boardPeriods?: KeyboardBoardPeriod[]}).boardPeriods ?? []),
    );
    const serializedBoard = board
      ? serializeBoardPeriod(board as KeyboardBoardPeriod & {
          geometry?: KeyboardGeometry | null;
          product?: KeyboardProduct | null;
          switch?: KeyboardSwitch | null;
        })
      : null;
    if (!serializedBoard || serializedBoard.isGap) continue;
    const formFactor = serializedBoard.geometry?.formFactor ?? null;
    if (opts.formFactor && formFactor !== opts.formFactor) continue;
    const productName = serializedBoard.product
      ? `${serializedBoard.product.brand} ${serializedBoard.product.model}`
      : [serializedBoard.customBrand, serializedBoard.customModel].filter(Boolean).join(' ') ||
        serializedBoard.geometry?.name ||
        null;
    const switchName = serializedBoard.switch?.name ?? serializedBoard.customSwitch;
    const lanes = (rig as KeyboardRig & {lanes?: Array<KeyboardLane & {periods?: KeyboardLanePeriod[]}>})
      .lanes ?? [];
    for (const lane of lanes) {
      const period = currentPeriod(lane.periods ?? []);
      if (!period || period.keysJson == null) continue;
      const count = period.keysJson.length;
      if (opts.keyCount && count !== opts.keyCount) continue;
      rows.push({
        playerId: rig.playerId,
        playerName: player?.name ?? '',
        rigId: rig.id,
        keyCount: count,
        keys: period.keysJson,
        signature: period.keySignature ?? keySignature(period.keysJson),
        geometrySlug: serializedBoard.geometry?.slug ?? null,
        formFactor,
        productName,
        sensing: serializedBoard.sensing,
        switchName,
        actuationMm: serializedBoard.actuationMm,
        rapidTriggerSplit: serializedBoard.rapidTriggerSplit,
        rapidTriggerActuationMm: serializedBoard.rapidTriggerActuationMm,
        rapidTriggerPressMm: serializedBoard.rapidTriggerPressMm,
        rapidTriggerReleaseMm: serializedBoard.rapidTriggerReleaseMm,
      });
    }
  }

  rows.sort((a, b) => a.playerName.localeCompare(b.playerName) || a.keyCount - b.keyCount);
  return {
    total: rows.length,
    limit,
    offset,
    items: rows.slice(offset, offset + limit),
  };
}

function isSentinelUpload(date: Date | null | undefined): boolean {
  if (!date) return true;
  const iso = date.toISOString();
  return (PASS_UPLOAD_SENTINEL_ISO as readonly string[]).includes(iso);
}

export type ResolvedPassBind = {
  source: 'override' | 'auto';
  lanePeriodId: number;
  rigId: number;
  keyCount: number;
  sinceDate: string | null;
  keys: string[] | null;
  signature: string | null;
};

export async function resolvePassBinds(
  playerId: number,
  passes: Array<{id: number; keyCount?: number | null; vidUploadTime?: Date | string | null}>,
): Promise<Record<number, ResolvedPassBind | null>> {
  const visible = await playerModuleOn(playerId);
  if (!visible || !passes.length) {
    return Object.fromEntries(passes.map((pass) => [pass.id, null]));
  }
  const rigs = await loadRigs(playerId);
  const periodById = new Map<number, {period: KeyboardLanePeriod; rigId: number; keyCount: number}>();
  for (const rig of rigs) {
    for (const lane of (rig as KeyboardRig & {lanes?: Array<KeyboardLane & {periods?: KeyboardLanePeriod[]}>}).lanes ?? []) {
      for (const period of lane.periods ?? []) {
        periodById.set(period.id, {
          period,
          rigId: rig.id,
          keyCount: period.keysJson?.length ?? lane.keyCount,
        });
      }
    }
  }

  const passIds = passes.map((pass) => pass.id);
  const overrides = await PassBindOverride.findAll({
    where: {playerId, passId: {[Op.in]: passIds}},
  });
  const overrideByPass = new Map(overrides.map((row) => [row.passId, row]));
  const result: Record<number, ResolvedPassBind | null> = {};

  for (const pass of passes) {
    const override = overrideByPass.get(pass.id);
    if (override) {
      const hit = periodById.get(override.lanePeriodId);
      if (hit) {
        result[pass.id] = {
          source: 'override',
          lanePeriodId: hit.period.id,
          rigId: hit.rigId,
          keyCount: hit.keyCount,
          sinceDate: sinceKey(hit.period.sinceDate),
          keys: hit.period.keysJson,
          signature: hit.period.keySignature,
        };
        continue;
      }
    }

    const keyCount = pass.keyCount == null ? null : Number(pass.keyCount);
    const instant =
      pass.vidUploadTime instanceof Date
        ? pass.vidUploadTime
        : pass.vidUploadTime
          ? new Date(pass.vidUploadTime)
          : null;
    if (keyCount == null || isSentinelUpload(instant)) {
      result[pass.id] = null;
      continue;
    }
    const iso = utcDateFromInstant(instant);
    if (!iso) {
      result[pass.id] = null;
      continue;
    }
    const matches: ResolvedPassBind[] = [];
    for (const rig of rigs) {
      const lanes =
        (rig as KeyboardRig & {lanes?: Array<KeyboardLane & {periods?: KeyboardLanePeriod[]}>}).lanes ??
        [];
      const fitting = lanes.flatMap((lane) =>
        (lane.periods ?? []).filter((period) => period.keysJson?.length === keyCount),
      );
      const group = fitting.map((period) => asRangePeriod({
        id: period.id,
        sinceDate: period.sinceDate,
        untilDate: period.untilDate,
        untilAuto: period.untilAuto,
      }));
      for (const period of fitting) {
        const range = asRangePeriod({
          id: period.id,
          sinceDate: period.sinceDate,
          untilDate: period.untilDate,
          untilAuto: period.untilAuto,
        });
        if (!periodCoversDate(range, iso, group)) continue;
        matches.push({
          source: 'auto',
          lanePeriodId: period.id,
          rigId: rig.id,
          keyCount: period.keysJson?.length ?? keyCount,
          sinceDate: sinceKey(period.sinceDate),
          keys: period.keysJson,
          signature: period.keySignature,
        });
      }
    }
    result[pass.id] = matches.length === 1 ? matches[0] : null;
  }
  return result;
}

export async function setPassBindOverride(
  actor: {playerId: number | null; isSuperAdmin?: boolean},
  passId: number,
  lanePeriodId: number | null,
) {
  const pass = await Pass.findByPk(passId, {attributes: ['id', 'playerId']});
  if (!pass) {
    throw new KeyboardSetupError(404, 'Pass not found');
  }
  const ownerId = pass.playerId;
  if (!actor.isSuperAdmin && ownerId !== actor.playerId) {
    throw new KeyboardSetupError(404, 'Pass not found');
  }
  if (lanePeriodId == null) {
    await PassBindOverride.destroy({where: {passId, playerId: ownerId}});
    return {ok: true, keyboardSetup: null};
  }
  const period = await KeyboardLanePeriod.findByPk(lanePeriodId, {
    include: [{model: KeyboardLane, as: 'lane', include: [{model: KeyboardRig, as: 'rig'}]}],
  });
  const rig = (period as KeyboardLanePeriod & {lane?: KeyboardLane & {rig?: KeyboardRig}} | null)?.lane
    ?.rig;
  if (!period || !rig || rig.playerId !== ownerId) {
    throw new KeyboardSetupError(400, 'Lane period does not belong to this player');
  }
  await PassBindOverride.upsert({passId, playerId: ownerId, lanePeriodId});
  const resolved = await resolvePassBinds(ownerId, [
    {id: passId, keyCount: period.keysJson?.length ?? null, vidUploadTime: null},
  ]);
  return {ok: true, keyboardSetup: resolved[passId]};
}

export async function listLanePeriodsForPlayer(playerId: number) {
  const {visible, rigs} = await getPlayerKeyboardSetups(playerId, {visibleOnly: false});
  void visible;
  const options: Array<{
    lanePeriodId: number;
    rigId: number;
    rigName: string | null;
    keyCount: number;
    sinceDate: string | null;
    isGap: boolean;
  }> = [];
  for (const rig of rigs) {
    for (const lane of rig.lanes) {
      for (const period of lane.periods) {
        options.push({
          lanePeriodId: period.id,
          rigId: rig.id,
          rigName: rig.name,
          keyCount: lane.keyCount,
          sinceDate: sinceKey(period.sinceDate),
          isGap: period.isGap,
        });
      }
    }
  }
  return options;
}

const FORM_FACTOR_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseFormFactorQuery(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string' || !FORM_FACTOR_SLUG.test(raw)) {
    throw new KeyboardSetupError(400, 'Invalid form factor');
  }
  return raw;
}

async function assertFormFactor(slug: string) {
  const row = await KeyboardFormFactor.findByPk(slug);
  if (!row) throw new KeyboardSetupError(400, 'Unknown form factor');
  return slug;
}

export async function createFormFactor(raw: {slug?: unknown; name?: unknown; note?: unknown}) {
  if (typeof raw.slug !== 'string' || !FORM_FACTOR_SLUG.test(raw.slug)) {
    throw new KeyboardSetupError(400, 'slug must be lowercase letters, numbers, and dashes');
  }
  const name = parseOptionalName(raw.name, 64);
  if (!name) throw new KeyboardSetupError(400, 'name is required');
  const note = parseOptionalName(raw.note, 500);
  const highest = await KeyboardFormFactor.max('sortOrder');
  const sortOrder = typeof highest === 'number' && Number.isFinite(highest) ? highest + 1 : 0;
  try {
    const row = await KeyboardFormFactor.create({slug: raw.slug, name, note, sortOrder});
    return serializeFormFactor(row);
  } catch (error) {
    if ((error as {name?: string}).name === 'SequelizeUniqueConstraintError') {
      throw new KeyboardSetupError(409, 'A form factor with that slug already exists');
    }
    throw error;
  }
}

export async function updateFormFactor(slug: string, raw: Record<string, unknown>) {
  const row = await KeyboardFormFactor.findByPk(slug);
  if (!row) throw new KeyboardSetupError(404, 'Form factor not found');
  const patch: Partial<{name: string; note: string | null}> = {};
  if ('name' in raw) {
    const name = parseOptionalName(raw.name, 64);
    if (!name) throw new KeyboardSetupError(400, 'name is required');
    patch.name = name;
  }
  if ('note' in raw) {
    patch.note = parseOptionalName(raw.note, 500);
  }
  await row.update(patch);
  return serializeFormFactor(row);
}

export async function reorderFormFactors(raw: {slugs?: unknown}) {
  if (!Array.isArray(raw.slugs)) throw new KeyboardSetupError(400, 'slugs must be an array');
  const slugs = raw.slugs.map((slug) => {
    if (typeof slug !== 'string' || !FORM_FACTOR_SLUG.test(slug)) {
      throw new KeyboardSetupError(400, 'Invalid form factor');
    }
    return slug;
  });
  if (new Set(slugs).size !== slugs.length) {
    throw new KeyboardSetupError(400, 'Duplicate form factor');
  }
  const rows = await KeyboardFormFactor.findAll();
  const known = new Set(rows.map((row) => row.slug));
  if (slugs.length !== rows.length || slugs.some((slug) => !known.has(slug))) {
    throw new KeyboardSetupError(400, 'slugs must list every form factor once');
  }
  await sequelize.transaction(async (transaction) => {
    await Promise.all(
      slugs.map((slug, index) => KeyboardFormFactor.update({sortOrder: index}, {where: {slug}, transaction})),
    );
  });
  const ordered = await KeyboardFormFactor.findAll({order: [['sortOrder', 'ASC'], ['name', 'ASC']]});
  return ordered.map(serializeFormFactor);
}

export async function deleteFormFactor(slug: string) {
  const used = await KeyboardGeometry.count({where: {formFactor: slug}});
  if (used) throw new KeyboardSetupError(409, 'Form factor is used by shapes');
  const row = await KeyboardFormFactor.findByPk(slug);
  if (!row) throw new KeyboardSetupError(404, 'Form factor not found');
  await row.destroy();
  return {ok: true};
}

export async function createGeometry(raw: {
  slug?: unknown;
  name?: unknown;
  formFactor?: unknown;
  keys?: unknown;
}) {
  const {parseStoredGeometryKeys} = await import('@/misc/utils/keyboards/kle.js');
  if (typeof raw.slug !== 'string' || !/^[a-z0-9-]{2,64}$/.test(raw.slug)) {
    throw new KeyboardSetupError(400, 'slug must be lowercase letters, numbers, and dashes');
  }
  const name = parseOptionalName(raw.name, MAX_KEYBOARD_NAME_LENGTH);
  if (!name) throw new KeyboardSetupError(400, 'name is required');
  const formFactor = parseFormFactorQuery(raw.formFactor);
  if (!formFactor) throw new KeyboardSetupError(400, 'formFactor is required');
  await assertFormFactor(formFactor);
  const keys = parseStoredGeometryKeys(raw.keys);
  try {
    const row = await KeyboardGeometry.create({slug: raw.slug, name, formFactor, keysJson: keys});
    return serializeGeometry(row);
  } catch (error) {
    if ((error as {name?: string}).name === 'SequelizeUniqueConstraintError') {
      throw new KeyboardSetupError(409, 'A geometry with that slug already exists');
    }
    throw error;
  }
}

export async function updateGeometry(id: number, raw: Record<string, unknown>) {
  const {parseStoredGeometryKeys} = await import('@/misc/utils/keyboards/kle.js');
  const row = await KeyboardGeometry.findByPk(id);
  if (!row) throw new KeyboardSetupError(404, 'Geometry not found');
  const patch: Partial<{name: string; formFactor: string; keysJson: StoredGeometryKey[]}> = {};
  if ('name' in raw) {
    const name = parseOptionalName(raw.name, MAX_KEYBOARD_NAME_LENGTH);
    if (!name) throw new KeyboardSetupError(400, 'name is required');
    patch.name = name;
  }
  if ('formFactor' in raw) {
    const formFactor = parseFormFactorQuery(raw.formFactor);
    if (!formFactor) throw new KeyboardSetupError(400, 'formFactor is required');
    await assertFormFactor(formFactor);
    patch.formFactor = formFactor;
  }
  if ('keys' in raw) {
    patch.keysJson = parseStoredGeometryKeys(raw.keys);
  }
  await row.update(patch);
  return serializeGeometry(row);
}

export async function deleteGeometry(id: number) {
  const used = await KeyboardBoardPeriod.count({where: {geometryId: id}});
  if (used) {
    throw new KeyboardSetupError(409, 'Geometry is used by player setups');
  }
  const row = await KeyboardGeometry.findByPk(id);
  if (!row) throw new KeyboardSetupError(404, 'Geometry not found');
  await KeyboardProduct.destroy({where: {geometryId: id}});
  await row.destroy();
  return {ok: true};
}

export async function createProduct(raw: {geometryId?: unknown; brand?: unknown; model?: unknown}) {
  const geometryId = Number(raw.geometryId);
  if (!Number.isInteger(geometryId) || geometryId <= 0) {
    throw new KeyboardSetupError(400, 'geometryId is required');
  }
  await assertGeometry(geometryId);
  const brand = parseOptionalName(raw.brand, MAX_KEYBOARD_NAME_LENGTH);
  const model = parseOptionalName(raw.model, MAX_KEYBOARD_NAME_LENGTH);
  if (!brand || !model) throw new KeyboardSetupError(400, 'brand and model are required');
  try {
    const row = await KeyboardProduct.create({geometryId, brand, model});
    return serializeProduct(row);
  } catch (error) {
    if ((error as {name?: string}).name === 'SequelizeUniqueConstraintError') {
      throw new KeyboardSetupError(409, 'That product already exists');
    }
    throw error;
  }
}

export async function updateProduct(id: number, raw: Record<string, unknown>) {
  const row = await KeyboardProduct.findByPk(id);
  if (!row) throw new KeyboardSetupError(404, 'Product not found');
  const patch: Partial<{geometryId: number; brand: string; model: string}> = {};
  if ('geometryId' in raw) {
    const geometryId = Number(raw.geometryId);
    await assertGeometry(geometryId);
    patch.geometryId = geometryId;
  }
  if ('brand' in raw) {
    const brand = parseOptionalName(raw.brand, MAX_KEYBOARD_NAME_LENGTH);
    if (!brand) throw new KeyboardSetupError(400, 'brand is required');
    patch.brand = brand;
  }
  if ('model' in raw) {
    const model = parseOptionalName(raw.model, MAX_KEYBOARD_NAME_LENGTH);
    if (!model) throw new KeyboardSetupError(400, 'model is required');
    patch.model = model;
  }
  await row.update(patch);
  return serializeProduct(row);
}

export async function deleteProduct(id: number) {
  const used = await KeyboardBoardPeriod.count({where: {productId: id}});
  if (used) throw new KeyboardSetupError(409, 'Product is used by player setups');
  const row = await KeyboardProduct.findByPk(id);
  if (!row) throw new KeyboardSetupError(404, 'Product not found');
  await row.destroy();
  return {ok: true};
}

export async function createSwitchRow(raw: {
  name?: unknown;
  sensing?: unknown;
  stem?: unknown;
  baseColor?: unknown;
  topColor?: unknown;
  stemColor?: unknown;
  baseOpacity?: unknown;
}) {
  const name = parseOptionalName(raw.name, MAX_KEYBOARD_NAME_LENGTH);
  if (!name) throw new KeyboardSetupError(400, 'name is required');
  let sensing = null;
  if (raw.sensing != null && raw.sensing !== '') {
    const spec = parseBoardSpecInput({geometryId: 1, sensing: raw.sensing});
    sensing = spec.sensing;
  }
  try {
    const row = await KeyboardSwitch.create({
      name,
      sensing,
      stem: parseSwitchStem(raw.stem),
      baseColor: parseSwitchColor(raw.baseColor),
      topColor: parseSwitchColor(raw.topColor),
      stemColor: parseSwitchColor(raw.stemColor),
      baseOpacity: parseBaseOpacity(raw.baseOpacity),
    });
    return serializeSwitch(row);
  } catch (error) {
    if ((error as {name?: string}).name === 'SequelizeUniqueConstraintError') {
      throw new KeyboardSetupError(409, 'A switch with that name already exists');
    }
    throw error;
  }
}

export async function updateSwitchRow(id: number, raw: Record<string, unknown>) {
  const row = await KeyboardSwitch.findByPk(id);
  if (!row) throw new KeyboardSetupError(404, 'Switch not found');
  const patch: Partial<{
    name: string;
    sensing: BoardSpecInput['sensing'];
    stem: KeyboardSwitchStem | null;
    baseColor: string | null;
    topColor: string | null;
    stemColor: string | null;
    baseOpacity: number | null;
  }> = {};
  if ('name' in raw) {
    const name = parseOptionalName(raw.name, MAX_KEYBOARD_NAME_LENGTH);
    if (!name) throw new KeyboardSetupError(400, 'name is required');
    patch.name = name;
  }
  if ('sensing' in raw) {
    const spec = parseBoardSpecInput({geometryId: 1, sensing: raw.sensing});
    patch.sensing = spec.sensing;
  }
  if ('stem' in raw) patch.stem = parseSwitchStem(raw.stem);
  if ('baseColor' in raw) patch.baseColor = parseSwitchColor(raw.baseColor);
  if ('topColor' in raw) patch.topColor = parseSwitchColor(raw.topColor);
  if ('stemColor' in raw) patch.stemColor = parseSwitchColor(raw.stemColor);
  if ('baseOpacity' in raw) patch.baseOpacity = parseBaseOpacity(raw.baseOpacity);
  await row.update(patch);
  return serializeSwitch(row);
}

export async function deleteSwitchRow(id: number) {
  const used = await KeyboardBoardPeriod.count({where: {switchId: id}});
  if (used) throw new KeyboardSetupError(409, 'Switch is used by player setups');
  const row = await KeyboardSwitch.findByPk(id);
  if (!row) throw new KeyboardSetupError(404, 'Switch not found');
  await row.destroy();
  return {ok: true};
}

export async function importGeometryFromKle(raw: Record<string, unknown>, geometryId?: number) {
  const {importKleRaw} = await import('@/misc/utils/keyboards/kle.js');
  const codes = Array.isArray(raw.codes)
    ? raw.codes.map((item) => (typeof item === 'string' ? item : ''))
    : undefined;
  const keys = importKleRaw(raw.kle, codes);
  if (geometryId != null) {
    if (!Number.isInteger(geometryId) || geometryId <= 0) {
      throw new KeyboardSetupError(400, 'Invalid geometry');
    }
    const patch: Record<string, unknown> = {keys};
    if (raw.name != null) patch.name = raw.name;
    if (raw.formFactor != null) patch.formFactor = raw.formFactor;
    return updateGeometry(geometryId, patch);
  }
  return createGeometry({
    slug: raw.slug,
    name: raw.name,
    formFactor: raw.formFactor,
    keys,
  });
}
