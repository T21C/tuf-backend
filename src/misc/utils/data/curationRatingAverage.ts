import {curationTypeRatingBucket, parseCurationFamilyTier} from './curationTypeFamilies.js';
import {rangeNumeric, snapToNearest} from './ratingNumeric.js';

export type CurationAverageTypeRef = {
  id: number;
  name?: string | null;
};

export type CurationAverageVote = {
  chartTypeId?: number | null;
  chartTypeHighId?: number | null;
  vfxTypeId?: number | null;
  vfxTypeHighId?: number | null;
};

type FamilyVote = {
  letter: string;
  numeric: number;
};

function typeTier(type: CurationAverageTypeRef): number | null {
  return parseCurationFamilyTier(type.name)?.tier ?? null;
}

function averageCurationBucket(
  votes: Array<{lowId: number | null; highId: number | null}>,
  types: readonly CurationAverageTypeRef[],
  bucket: 'chart' | 'vfx',
): number | null {
  const byId = new Map(types.map((type) => [type.id, type]));
  const familyVotes: FamilyVote[] = [];

  for (const vote of votes) {
    const low = vote.lowId != null ? byId.get(vote.lowId) : undefined;
    const high = vote.highId != null ? byId.get(vote.highId) : undefined;
    const lowParsed = parseCurationFamilyTier(low?.name);
    const highParsed = parseCurationFamilyTier(high?.name);
    const letter = lowParsed?.letter ?? highParsed?.letter;
    if (!letter) continue;
    const name = low?.name ?? high?.name;
    if (curationTypeRatingBucket(name) !== bucket) continue;
    if (lowParsed && highParsed && lowParsed.letter !== highParsed.letter) continue;
    const numeric = rangeNumeric(lowParsed?.tier ?? null, highParsed?.tier ?? null);
    if (numeric == null) continue;
    familyVotes.push({letter, numeric});
  }

  if (familyVotes.length === 0) return null;

  const counts = new Map<string, number>();
  for (const vote of familyVotes) {
    counts.set(vote.letter, (counts.get(vote.letter) || 0) + 1);
  }

  let bestLetter: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [letter, count] of counts) {
    if (count > bestCount) {
      bestLetter = letter;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  if (tied || bestLetter == null) return null;

  const nums = familyVotes.filter((vote) => vote.letter === bestLetter).map((vote) => vote.numeric);
  const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
  const familyTypes = types.filter((type) => {
    const parsed = parseCurationFamilyTier(type.name);
    return parsed?.letter === bestLetter && curationTypeRatingBucket(type.name) === bucket;
  });
  const snapped = snapToNearest(familyTypes, (type) => typeTier(type) ?? Number.NaN, mean);
  return snapped?.id ?? null;
}

export function averageCurationRatingPicks(
  details: readonly CurationAverageVote[],
  types: readonly CurationAverageTypeRef[],
): {chartTypeId: number | null; vfxTypeId: number | null} {
  return {
    chartTypeId: averageCurationBucket(
      details.map((detail) => ({
        lowId: detail.chartTypeId ?? null,
        highId: detail.chartTypeHighId ?? null,
      })),
      types,
      'chart',
    ),
    vfxTypeId: averageCurationBucket(
      details.map((detail) => ({
        lowId: detail.vfxTypeId ?? null,
        highId: detail.vfxTypeHighId ?? null,
      })),
      types,
      'vfx',
    ),
  };
}
