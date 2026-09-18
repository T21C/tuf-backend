import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPlayerRanksAndSpecials,
  scoreRatingAccuracy,
  settleKernel,
  shrinkMean,
  type DifficultyRef,
} from './ratingAccuracy.js';

function makePgu(letter: 'P' | 'G' | 'U', n: number, idBase: number): DifficultyRef {
  const band = letter === 'P' ? 0 : letter === 'G' ? 20 : 40;
  return {
    id: idBase + n,
    name: `${letter}${n}`,
    type: 'PGU',
    sortOrder: band + n,
  };
}

function special(id: number, name: string, sortOrder = 99): DifficultyRef {
  return {id, name, type: 'SPECIAL', sortOrder};
}

function allDiffs(): DifficultyRef[] {
  const list: DifficultyRef[] = [];
  for (let n = 1; n <= 20; n++) {
    list.push(makePgu('P', n, 0));
    list.push(makePgu('G', n, 100));
    list.push(makePgu('U', n, 200));
  }
  for (let t = 0; t <= 4; t++) {
    list.push(special(300 + t, `GQ${t}`));
    list.push(special(310 + t, `UQ${t}`));
    list.push(special(320 + t, `Q${t}`));
  }
  list.push(special(400, 'Qq'));
  list.push(special(401, '-2'));
  list.push(special(402, 'Censored'));
  return list;
}

const diffs = allDiffs();
const g5 = diffs.find((d) => d.name === 'G5')!;
const g6 = diffs.find((d) => d.name === 'G6')!;
const gq1 = diffs.find((d) => d.name === 'GQ1')!;
const p7 = diffs.find((d) => d.name === 'P7')!;
const u1 = diffs.find((d) => d.name === 'U1')!;
const g20 = diffs.find((d) => d.name === 'G20')!;
const minus2 = diffs.find((d) => d.name === '-2')!;
const qq = diffs.find((d) => d.name === 'Qq')!;

test('collectPlayerRanksAndSpecials expands G5~G8 and GQ1', () => {
  const range = collectPlayerRanksAndSpecials('G5~8', diffs);
  assert.deepEqual(
    range.ranks.map((d) => d.name),
    ['G5', 'G6', 'G7', 'G8'],
  );
  const bucket = collectPlayerRanksAndSpecials('GQ1', diffs);
  assert.deepEqual(
    bucket.ranks.map((d) => d.name),
    ['G5', 'G6', 'G7', 'G8'],
  );
});

test('collectPlayerRanksAndSpecials keeps G10 from G10~-2 and the special', () => {
  const claim = collectPlayerRanksAndSpecials('G10~-2', diffs);
  assert.deepEqual(
    claim.ranks.map((d) => d.name),
    ['G10'],
  );
  assert.deepEqual(claim.specials, ['-2']);
});

test('exact G5 vs settled G5 scores 1', () => {
  const result = scoreRatingAccuracy({
    frozenRating: 'G5',
    settled: g5,
    clearsAtSettle: 3,
    difficulties: diffs,
  });
  assert.equal(result.track, 'pgu');
  assert.equal(result.scoringMode, 'rank');
  assert.equal(result.score, 1);
});

test('G6 vs settled G5 is exp(-0.5)', () => {
  const result = scoreRatingAccuracy({
    frozenRating: 'G6',
    settled: g5,
    clearsAtSettle: 1,
    difficulties: diffs,
  });
  assert.equal(result.scoringMode, 'rank');
  assert.ok(result.score != null);
  assert.ok(Math.abs(result.score - Math.exp(-0.5)) < 1e-9);
});

test('G5~6 vs settled G5 is the mean of G5 and G6 kernels', () => {
  const result = scoreRatingAccuracy({
    frozenRating: 'G5~6',
    settled: g5,
    clearsAtSettle: 1,
    difficulties: diffs,
  });
  const expected = (1 + Math.exp(-0.5)) / 2;
  assert.ok(result.score != null);
  assert.ok(Math.abs(result.score - expected) < 1e-9);
});

test('GQ1 settle is a plateau on G5-G8', () => {
  const kernel = settleKernel(gq1, 0, diffs);
  assert.equal(kernel.scoringMode, 'q');
  assert.deepEqual(
    kernel.plateau.map((d) => d.name),
    ['G5', 'G6', 'G7', 'G8'],
  );
  const labeled = special(399, 'GQ1 (G5~G8)');
  const labeledKernel = settleKernel(labeled, 2, diffs);
  assert.equal(labeledKernel.scoringMode, 'q');
  assert.deepEqual(
    labeledKernel.plateau.map((d) => d.name),
    ['G5', 'G6', 'G7', 'G8'],
  );
  const exact = scoreRatingAccuracy({
    frozenRating: 'G6',
    settled: labeled,
    clearsAtSettle: 2,
    difficulties: diffs,
  });
  assert.equal(exact.score, 1);
  const bucket = scoreRatingAccuracy({
    frozenRating: 'GQ1',
    settled: gq1,
    clearsAtSettle: 0,
    difficulties: diffs,
  });
  assert.equal(bucket.score, 1);
});

test('synthetic P-Q when P settle has zero clears', () => {
  const kernel = settleKernel(p7, 0, diffs);
  assert.equal(kernel.scoringMode, 'q');
  assert.deepEqual(
    kernel.plateau.map((d) => d.name),
    ['P5', 'P6', 'P7', 'P8'],
  );
  const cleared = settleKernel(p7, 1, diffs);
  assert.equal(cleared.scoringMode, 'rank');
  assert.equal(cleared.center?.name, 'P7');
});

test('G20 vs U1 is one ladder step', () => {
  const result = scoreRatingAccuracy({
    frozenRating: 'G20',
    settled: u1,
    clearsAtSettle: 4,
    difficulties: diffs,
  });
  assert.ok(result.score != null);
  assert.ok(Math.abs(result.score - Math.exp(-0.5)) < 1e-9);
  const range = scoreRatingAccuracy({
    frozenRating: 'G20-U1',
    settled: u1,
    clearsAtSettle: 4,
    difficulties: diffs,
  });
  const expected = (Math.exp(-0.5) + 1) / 2;
  assert.ok(range.score != null);
  assert.ok(Math.abs(range.score - expected) < 1e-9);
});

test('mixed G10~-2 scores PGU part when settled G11', () => {
  const g11 = diffs.find((d) => d.name === 'G11')!;
  const result = scoreRatingAccuracy({
    frozenRating: 'G10~-2',
    settled: g11,
    clearsAtSettle: 2,
    difficulties: diffs,
  });
  assert.equal(result.track, 'pgu');
  assert.deepEqual(result.scoredRankNames, ['G10']);
  assert.ok(result.score != null);
  assert.ok(Math.abs(result.score - Math.exp(-0.5)) < 1e-9);
});

test('mixed G10~-2 scores 1 when settled -2', () => {
  const result = scoreRatingAccuracy({
    frozenRating: 'G10~-2',
    settled: minus2,
    clearsAtSettle: 0,
    difficulties: diffs,
  });
  assert.equal(result.track, 'special');
  assert.equal(result.score, 1);
});

test('only -2 vs settled G11 is a PGU miss of 0, not skip', () => {
  const result = scoreRatingAccuracy({
    frozenRating: '-2',
    settled: g6,
    clearsAtSettle: 1,
    difficulties: diffs,
  });
  assert.equal(result.track, 'pgu');
  assert.equal(result.score, 0);
});

test('garbage rating is skip', () => {
  const result = scoreRatingAccuracy({
    frozenRating: 'asdf',
    settled: g5,
    clearsAtSettle: 1,
    difficulties: diffs,
  });
  assert.equal(result.track, 'skip');
  assert.equal(result.score, null);
});

test('Qq is a special settle, not a Q plateau', () => {
  const kernel = settleKernel(qq, 0, diffs);
  assert.equal(kernel.scoringMode, 'special');
  const hit = scoreRatingAccuracy({
    frozenRating: 'Qq',
    settled: qq,
    clearsAtSettle: 0,
    difficulties: diffs,
  });
  assert.equal(hit.track, 'special');
  assert.equal(hit.score, 1);
});

test('bare Q1 aliases UQ1 plateau', () => {
  const q1 = diffs.find((d) => d.name === 'Q1')!;
  const kernel = settleKernel(q1, 0, diffs);
  assert.equal(kernel.scoringMode, 'q');
  assert.deepEqual(
    kernel.plateau.map((d) => d.name),
    ['U5', 'U6', 'U7', 'U8'],
  );
});

test('Q plateau one step off uses τ = 3', () => {
  const g4 = diffs.find((d) => d.name === 'G4')!;
  const result = scoreRatingAccuracy({
    frozenRating: 'G4',
    settled: gq1,
    clearsAtSettle: 0,
    difficulties: diffs,
  });
  assert.equal(result.scoringMode, 'q');
  assert.ok(result.score != null);
  assert.ok(Math.abs(result.score - Math.exp(-1 / 3)) < 1e-9);
});

test('Q chart stops at U20 and does not invent ranks past the ladder', () => {
  const uq3 = special(330, 'UQ3 (U13~U16)');
  const result = scoreRatingAccuracy({
    frozenRating: 'U14-U15',
    settled: uq3,
    clearsAtSettle: 0,
    difficulties: [...diffs, uq3],
  });
  const names = result.chart.points.map((p) => p.name);
  assert.ok(names.includes('U20'));
  assert.equal(result.chart.points.at(-1)?.name, 'U20');
  assert.ok(result.chart.points.every((p) => p.name && !p.phantom));
  const p1 = scoreRatingAccuracy({
    frozenRating: 'P2',
    settled: diffs.find((d) => d.name === 'P2')!,
    clearsAtSettle: 0,
    difficulties: diffs,
  });
  assert.equal(p1.chart.points[0]?.name, 'P1');
  assert.ok(p1.chart.points.every((p) => p.name && !p.phantom));
});

test('Q distance uses PGU index, not specials sitting in sortOrder', () => {
  const gappy = diffs.map((d) => {
    const match = d.name.match(/^U(\d+)$/i);
    if (!match) return d;
    const n = Number(match[1]);
    if (n <= 16) return d;
    return {...d, sortOrder: d.sortOrder + 1};
  });
  gappy.push(special(331, 'UQ3 (U13~U16)', 57));
  const result = scoreRatingAccuracy({
    frozenRating: 'U17',
    settled: special(331, 'UQ3 (U13~U16)', 57),
    clearsAtSettle: 0,
    difficulties: gappy,
  });
  assert.ok(result.score != null);
  assert.ok(Math.abs(result.score - Math.exp(-1 / 3)) < 1e-9);
});
