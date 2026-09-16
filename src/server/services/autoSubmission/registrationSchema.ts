import { z } from 'zod';

const count = z.number().int().min(0).max(10_000_000);
export const registrationSchema = z.object({
  run_id: z.uuid(),
  owner_id: z.uuid(),
  grant_id: z.uuid(),
  level_id: z.number().int().positive(),
  current_file_id: z.string().min(1).max(256),
  validation: z.object({
    validation_contract_version: z.literal(2),
    validation_status: z.enum(['skipped_trusted_tester', 'validated']),
    result_provenance: z.enum(['recorded_game_result', 'gameplay_validator']),
    validator_version: z.string().min(1).max(64),
    rules_version: z.string().min(1).max(64),
    evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
    official_file_id: z.string().min(1).max(256),
    chart_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    gameplay_hash_version: z.number().int().min(1).max(4_294_967_295),
    gameplay_hash: z.string().regex(/^[a-f0-9]{64}$/),
    speed: z.number().min(1).max(100),
    key_count: z.number().int().min(1).max(64),
    is_no_hold_tap: z.boolean(),
    is_adofai_v2: z.boolean(),
    adofai_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    is_x_perfect_mode: z.boolean(),
    perfect_minus: count,
    perfect_plus: count,
    // Overload, TooEarly, Early, EarlyPerfect, Perfect, LatePerfect, Late, TooLate, Miss.
    judgments: z.tuple([count, count, count, count, count, count, count, count, count]),
  }).strict(),
}).strict().superRefine((input, context) => {
  const { validation } = input;
  const { judgments } = validation;
  if (validation.validation_status === 'skipped_trusted_tester'
      && validation.result_provenance !== 'recorded_game_result') {
    context.addIssue({
      code: 'custom',
      path: ['validation', 'result_provenance'],
      message: 'Skipped validation must use recorded game result provenance',
    });
  }
  if (validation.validation_status === 'validated'
      && validation.result_provenance !== 'gameplay_validator') {
    context.addIssue({
      code: 'custom',
      path: ['validation', 'result_provenance'],
      message: 'Validated results must use gameplay validator provenance',
    });
  }
  if (validation.is_adofai_v2 !== (validation.adofai_version === 1)) {
    context.addIssue({
      code: 'custom',
      path: ['validation', 'is_adofai_v2'],
      message: 'Legacy ADOFAI v2 flag must agree with adofai_version',
    });
  }
  if (validation.is_x_perfect_mode && validation.adofai_version !== 3) {
    context.addIssue({
      code: 'custom',
      path: ['validation', 'is_x_perfect_mode'],
      message: 'XPerfect mode is only available in ADOFAI era 3',
    });
  }
  if (!validation.is_x_perfect_mode
      && (validation.perfect_minus !== 0 || validation.perfect_plus !== 0)) {
    context.addIssue({
      code: 'custom',
      path: ['validation', 'perfect_minus'],
      message: 'Split Perfect counts are only valid in XPerfect mode',
    });
  }
  if (judgments[0] !== 0 || judgments[8] !== 0
      || (!judgments.slice(1, 8).some(value => value > 0)
        && validation.perfect_minus === 0 && validation.perfect_plus === 0)) {
    context.addIssue({
      code: 'custom',
      path: ['validation', 'judgments'],
      message: 'Only a completed run without failures can be registered',
    });
  }
  if (input.current_file_id !== validation.official_file_id) {
    context.addIssue({
      code: 'custom',
      path: ['current_file_id'],
      message: 'Validation must reference the official file being registered',
    });
  }
});

export type RegistrationInput = z.infer<typeof registrationSchema>;

export function eligibleDifficulty(type: string, name: string): boolean {
  return type === 'PGU' && /^[PG](?:[1-9]|1[0-9]|20)$/.test(name);
}
