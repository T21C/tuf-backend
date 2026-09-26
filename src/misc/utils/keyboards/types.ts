export const KEYBOARD_FORM_FACTORS = ['full', 'tkl', '96', '75', '65', 'other'] as const;
export type KeyboardFormFactor = string;

export const KEYBOARD_SENSING_TYPES = ['mechanical', 'optical', 'hall', 'other'] as const;
export type KeyboardSensing = (typeof KEYBOARD_SENSING_TYPES)[number];

export const KEYBOARD_SWITCH_STEMS = ['linear', 'tactile', 'clicky', 'optical', 'magnetic'] as const;
export type KeyboardSwitchStem = (typeof KEYBOARD_SWITCH_STEMS)[number];

export const MAX_KEYBOARD_RIGS_PER_PLAYER = 8;
export const MAX_LANES_PER_RIG = 12;
export const MAX_PERIODS_PER_LIST = 40;
export const MAX_KEY_COUNT = 64;
export const MAX_KEYBIND_NOTE_LENGTH = 500;
export const MAX_KEYBOARD_NAME_LENGTH = 120;
export const MAX_RIG_NAME_LENGTH = 80;
export const KEY_SIGNATURE_SEPARATOR = '\u001f';

export const PASS_UPLOAD_SENTINEL_ISO = [
  '2023-07-27T07:27:27.000Z',
  '2023-01-01T07:27:27.000Z',
] as const;

export type StoredKeyVariant = 'display' | 'dial';

export type StoredGeometryKey = {
  code: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bindable: boolean;
  offsetX?: number;
  variant?: StoredKeyVariant;
  x2?: number;
  y2?: number;
  w2?: number;
  h2?: number;
};

export type GeometrySeed = {
  slug: string;
  name: string;
  formFactor: KeyboardFormFactor;
  keys: StoredGeometryKey[];
};

export type BoardSpecInput = {
  geometryId: number;
  productId?: number | null;
  customBrand?: string | null;
  customModel?: string | null;
  sensing?: KeyboardSensing | null;
  switchId?: number | null;
  customSwitch?: string | null;
  actuationMm?: number | null;
  rapidTriggerSplit?: boolean;
  rapidTriggerActuationMm?: number | null;
  rapidTriggerPressMm?: number | null;
  rapidTriggerReleaseMm?: number | null;
  colorway?: string | null;
  note?: string | null;
  keyOverrides?: BoardKeyOverrideInput[];
};

export type BoardKeyOverrideInput = {
  code: string;
  socketEmpty?: boolean;
  switchId?: number | null;
  customSwitch?: string | null;
};

export type TimelinePeriod = {
  id: number;
  sinceDate: string | null;
  untilDate?: string | null;
  untilAuto?: boolean;
  isGap?: boolean;
};

export class KeyboardSetupError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'KeyboardSetupError';
    this.status = status;
  }
}
