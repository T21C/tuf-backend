import type {TournamentTierKind} from '@/models/tournaments/TournamentTier.js';

export interface TierTemplateEntry {
  code: string;
  label: string;
  kind: TournamentTierKind;
  rankWeight: number;
  isPodium: boolean;
  isShowcaseEligible: boolean;
  sortOrder: number;
}

export interface TierTemplate {
  id: string;
  name: string;
  tiers: TierTemplateEntry[];
}

function ordinalLabel(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th Place`;
  switch (n % 10) {
    case 1:
      return `${n}st Place`;
    case 2:
      return `${n}nd Place`;
    case 3:
      return `${n}rd Place`;
    default:
      return `${n}th Place`;
  }
}

function ordinalTiers(count: number): TierTemplateEntry[] {
  return Array.from({length: count}, (_, i) => {
    const n = i + 1;
    return {
      code: String(n),
      label: ordinalLabel(n),
      kind: 'ordinal' as const,
      rankWeight: n,
      isPodium: n <= 3,
      isShowcaseEligible: true,
      sortOrder: i,
    };
  });
}

export const TIER_TEMPLATES: TierTemplate[] = [
  {
    id: 'podium4',
    name: 'Podium (1st–4th)',
    tiers: ordinalTiers(4),
  },
  {
    id: 'podium6',
    name: 'Podium (1st–6th)',
    tiers: ordinalTiers(6),
  },
  {
    id: 'awc',
    name: 'AWC-style',
    tiers: [
      ...ordinalTiers(4),
      {
        code: 'RO8',
        label: 'Round of 8',
        kind: 'bracket',
        rankWeight: 8,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 4,
      },
      {
        code: 'RO16',
        label: 'Round of 16',
        kind: 'bracket',
        rankWeight: 16,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 5,
      },
      {
        code: 'G',
        label: 'Group Stage',
        kind: 'stage',
        rankWeight: 32,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 6,
      },
      {
        code: 'C',
        label: 'Course Stage',
        kind: 'stage',
        rankWeight: 48,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 7,
      },
      {
        code: 'Q',
        label: 'Qualifier',
        kind: 'qualifier',
        rankWeight: 64,
        isPodium: false,
        isShowcaseEligible: false,
        sortOrder: 8,
      },
    ],
  },
  {
    id: 'cdf',
    name: 'CDF-style',
    tiers: [
      ...ordinalTiers(4),
      {
        code: 'SF',
        label: 'Semi-Final',
        kind: 'stage',
        rankWeight: 6,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 4,
      },
      {
        code: 'R4',
        label: 'Round 4',
        kind: 'round',
        rankWeight: 10,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 5,
      },
      {
        code: 'R3',
        label: 'Round 3',
        kind: 'round',
        rankWeight: 14,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 6,
      },
      {
        code: 'R2',
        label: 'Round 2',
        kind: 'round',
        rankWeight: 18,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 7,
      },
      {
        code: 'R1',
        label: 'Round 1',
        kind: 'round',
        rankWeight: 22,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 8,
      },
    ],
  },
  {
    id: 'swiss_ro',
    name: 'Swiss / Round-of',
    tiers: [
      ...ordinalTiers(4),
      {
        code: 'RO6',
        label: 'Round of 6',
        kind: 'bracket',
        rankWeight: 6,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 4,
      },
      {
        code: 'RO8',
        label: 'Round of 8',
        kind: 'bracket',
        rankWeight: 8,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 5,
      },
      {
        code: 'RO12',
        label: 'Round of 12',
        kind: 'bracket',
        rankWeight: 12,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 6,
      },
      {
        code: 'RO16',
        label: 'Round of 16',
        kind: 'bracket',
        rankWeight: 16,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 7,
      },
      {
        code: 'RO24',
        label: 'Round of 24',
        kind: 'bracket',
        rankWeight: 24,
        isPodium: false,
        isShowcaseEligible: true,
        sortOrder: 8,
      },
      {
        code: 'Q',
        label: 'Qualifier',
        kind: 'qualifier',
        rankWeight: 48,
        isPodium: false,
        isShowcaseEligible: false,
        sortOrder: 9,
      },
    ],
  },
  {
    id: 'empty',
    name: 'Empty (custom)',
    tiers: [],
  },
];

export function getTierTemplate(id: string): TierTemplate | undefined {
  return TIER_TEMPLATES.find(t => t.id === id);
}

/** Infer tier metadata from a free-form placement code (e.g. RO8, SF, 1, R2). */
export function inferTierFromCode(rawCode: string): TierTemplateEntry {
  const code = rawCode.trim().toUpperCase();
  const ordinalMatch = /^(\d+)$/.exec(code);
  if (ordinalMatch) {
    const n = parseInt(ordinalMatch[1], 10);
    return {
      code: String(n),
      label: ordinalLabel(n),
      kind: 'ordinal',
      rankWeight: n,
      isPodium: n <= 3,
      isShowcaseEligible: true,
      sortOrder: n,
    };
  }

  const roMatch = /^RO(\d+)$/.exec(code);
  if (roMatch) {
    const n = parseInt(roMatch[1], 10);
    return {
      code,
      label: `Round of ${n}`,
      kind: 'bracket',
      rankWeight: n,
      isPodium: false,
      isShowcaseEligible: true,
      sortOrder: n + 10,
    };
  }

  const rMatch = /^R(\d+)$/.exec(code);
  if (rMatch) {
    const n = parseInt(rMatch[1], 10);
    return {
      code,
      label: `Round ${n}`,
      kind: 'round',
      rankWeight: 20 + (10 - n),
      isPodium: false,
      isShowcaseEligible: true,
      sortOrder: 20 + n,
    };
  }

  const named: Record<string, TierTemplateEntry> = {
    SF: {
      code: 'SF',
      label: 'Semi-Final',
      kind: 'stage',
      rankWeight: 6,
      isPodium: false,
      isShowcaseEligible: true,
      sortOrder: 6,
    },
    Q: {
      code: 'Q',
      label: 'Qualifier',
      kind: 'qualifier',
      rankWeight: 64,
      isPodium: false,
      isShowcaseEligible: false,
      sortOrder: 64,
    },
    G: {
      code: 'G',
      label: 'Group Stage',
      kind: 'stage',
      rankWeight: 32,
      isPodium: false,
      isShowcaseEligible: true,
      sortOrder: 32,
    },
    C: {
      code: 'C',
      label: 'Course Stage',
      kind: 'stage',
      rankWeight: 48,
      isPodium: false,
      isShowcaseEligible: true,
      sortOrder: 48,
    },
  };

  if (named[code]) return named[code];

  return {
    code,
    label: code,
    kind: 'custom',
    rankWeight: 100,
    isPodium: false,
    isShowcaseEligible: true,
    sortOrder: 100,
  };
}

/** Parse prize codes like `1st`, `RO8WD`, `4WD`, `R2WD` → base code + withdrew flag. */
export function parsePrizeCode(raw: string): {code: string; withdrew: boolean} {
  let prize = String(raw || '').trim();
  if (!prize) return {code: '', withdrew: false};

  // Display forms: 1st, 2nd, 3rd, 4th
  const ordinalSuffix = /^(\d+)(?:st|nd|rd|th)$/i.exec(prize);
  if (ordinalSuffix) {
    prize = ordinalSuffix[1];
  }

  let withdrew = false;
  if (/WD$/i.test(prize)) {
    withdrew = true;
    prize = prize.replace(/WD$/i, '');
  }

  return {code: prize.toUpperCase(), withdrew};
}
