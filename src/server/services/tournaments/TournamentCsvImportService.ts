import Tournament from '@/models/tournaments/Tournament.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentSeries from '@/models/tournaments/TournamentSeries.js';
import type {TournamentTrack} from '@/models/tournaments/Tournament.js';
import {
  buildNameLookupMaps,
  lookupNameId,
} from './PlacementNameResolver.js';
import {
  inferTierFromCode,
  parsePrizeCode,
} from './tierTemplates.js';
import {PlacementRewardService} from './PlacementRewardService.js';
import {PlacementCreditService} from './PlacementCreditService.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

export interface CsvPlacementPair {
  prize: string;
  name: string;
}

export interface CsvTournamentRow {
  shortName: string;
  fullName: string;
  aka: string;
  organizers: string[];
  youtubeUrl: string;
  packRef: string;
  notes: string;
  isResultsFinal: boolean;
  isHidden: boolean;
  placements: CsvPlacementPair[];
}

export interface ImportReport {
  tournamentsCreated: number;
  tournamentsUpdated: number;
  placementsCreated: number;
  placementsSkipped: number;
  tiersCreated: number;
  linked: number;
  unmatchedNames: string[];
  seriesCreated: string[];
  errors: string[];
}

const SERIES_PREFIXES: {prefix: RegExp; slug: string; name: string}[] = [
  {prefix: /^AWC\b/i, slug: 'awc', name: 'Adofai World Championship'},
  {prefix: /^CDF\b/i, slug: 'cdf', name: 'CameraㆍDecoㆍFilter'},
  {prefix: /^EPC\b/i, slug: 'epc', name: 'Effect Playing Contest'},
  {prefix: /^ATC\b/i, slug: 'atc', name: 'Adofai Team Championship'},
  {prefix: /^ACC\b/i, slug: 'acc', name: 'Adofai China Cup'},
  {prefix: /^ARL\b/i, slug: 'arl', name: 'ARES Rookie League'},
  {prefix: /^APL\b/i, slug: 'apl', name: 'ARES Pro League'},
  {prefix: /^RCL\b/i, slug: 'rcl', name: 'Rookie Charter League'},
  {prefix: /^LDCC\b/i, slug: 'ldcc', name: 'Low-Diff Charting Contest'},
  {prefix: /^FAINT\b/i, slug: 'faint', name: 'FAINT'},
  {prefix: /^UnderbarGame\b/i, slug: 'underbar', name: 'UnderbarGame'},
  {prefix: /^AxS\b/i, slug: 'axs', name: 'AxS'},
  {prefix: /^CSC\b/i, slug: 'csc', name: 'Charting Skill Contest'},
  {prefix: /^SMTL\b/i, slug: 'smtl', name: 'Show Me The Level'},
];

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseBool(value: string): boolean {
  const v = value.trim().toUpperCase();
  return v === 'TRUE' || v === 'Y' || v === 'YES' || v === '1';
}

function extractYear(shortName: string, fullName: string): number | null {
  const m = /(\d{4})/.exec(`${shortName} ${fullName}`);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse Creator/Player tournament placement CSV text into structured rows.
 * Supports both display sheets (1st/2nd) and EDIT HERE sheets (1/2).
 */
export function parseTournamentCsv(csvText: string): CsvTournamentRow[] {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const isEditHere = header[0] === 'value paste only' || header.includes('event full name');

  const rows: CsvTournamentRow[] = [];

  for (let li = 1; li < lines.length; li++) {
    const cells = parseCsvLine(lines[li]);
    if (!cells.length) continue;

    let shortName: string;
    let fullName: string;
    let aka: string;
    let organizers: string[];
    let youtubeUrl: string;
    let packRef: string;
    let notes: string;
    let isResultsFinal: boolean;
    let isHidden: boolean;
    let placementStart: number;

    if (isEditHere) {
      // VALUE PASTE ONLY, Event Full Name, aka, (empty), held by, held by, held by, yt link, pack link, notes, done?, hide, VALUE PASTE ONLY, Prize, Name, ...
      shortName = (cells[0] || '').trim();
      fullName = (cells[1] || '').trim();
      aka = (cells[2] || '').trim();
      organizers = [cells[4], cells[5], cells[6]]
        .map(s => (s || '').trim())
        .filter(Boolean);
      youtubeUrl = (cells[7] || '').trim();
      packRef = (cells[8] || '').trim();
      notes = (cells[9] || '').trim();
      isResultsFinal = parseBool(cells[10] || '');
      isHidden = parseBool(cells[11] || '');
      placementStart = 13;
    } else {
      // Event, Full Name, Done?, Held By, Held By, Held By, YouTube, TUF Pack, Other Notes, (empty), (empty), TRUE/FALSE, TRUE/FALSE, Prize, Name, ...
      shortName = (cells[0] || '').trim();
      fullName = (cells[1] || '').trim();
      isResultsFinal = parseBool(cells[2] || '');
      organizers = [cells[3], cells[4], cells[5]]
        .map(s => (s || '').trim())
        .filter(Boolean);
      youtubeUrl = (cells[6] || '').trim();
      packRef = (cells[7] || '').trim();
      notes = (cells[8] || '').trim();
      // columns 9-10 unused; 11-12 are done/hide flags in some exports
      isHidden = parseBool(cells[12] || '') || parseBool(cells[11] || '');
      // Prefer explicit done flag in col 11 when present
      if (cells[11] != null && String(cells[11]).trim() !== '') {
        isResultsFinal = parseBool(cells[11]);
      }
      placementStart = 13;
      aka = '';
    }

    if (!shortName) continue;

    const placements: CsvPlacementPair[] = [];
    for (let i = placementStart; i + 1 < cells.length; i += 2) {
      const prize = (cells[i] || '').trim();
      const name = (cells[i + 1] || '').trim();
      if (!prize && !name) continue;
      if (!prize || !name) continue;
      placements.push({prize, name});
    }

    rows.push({
      shortName,
      fullName,
      aka,
      organizers,
      youtubeUrl,
      packRef,
      notes,
      isResultsFinal,
      isHidden,
      placements,
    });
  }

  return rows;
}

async function ensureSeries(
  shortName: string,
  seriesCache: Map<string, number>,
  created: string[],
): Promise<number | null> {
  for (const entry of SERIES_PREFIXES) {
    if (!entry.prefix.test(shortName)) continue;
    if (seriesCache.has(entry.slug)) return seriesCache.get(entry.slug)!;
    const [series, wasCreated] = await TournamentSeries.findOrCreate({
      where: {slug: entry.slug},
      defaults: {slug: entry.slug, name: entry.name},
    });
    seriesCache.set(entry.slug, series.id);
    if (wasCreated) created.push(entry.slug);
    return series.id;

  }
  return null;
}

export class TournamentCsvImportService {
  private static instance: TournamentCsvImportService;

  static getInstance(): TournamentCsvImportService {
    if (!this.instance) this.instance = new TournamentCsvImportService();
    return this.instance;
  }

  async importCsv(
    csvText: string,
    track: TournamentTrack,
    options: {dryRun?: boolean; replacePlacements?: boolean} = {},
  ): Promise<ImportReport> {
    const dryRun = Boolean(options.dryRun);
    const replacePlacements = options.replacePlacements !== false;
    const rows = parseTournamentCsv(csvText);
    const report: ImportReport = {
      tournamentsCreated: 0,
      tournamentsUpdated: 0,
      placementsCreated: 0,
      placementsSkipped: 0,
      tiersCreated: 0,
      linked: 0,
      unmatchedNames: [],
      seriesCreated: [],
      errors: [],
    };

    if (!rows.length) {
      report.errors.push('No tournament rows found in CSV');
      return report;
    }

    if (dryRun) {
      for (const row of rows) {
        const existing = await Tournament.findOne({
          where: {shortName: row.shortName},
        });
        if (existing) {
          if (existing.track !== track) {
            report.errors.push(
              `${row.shortName}: tournament exists with track "${existing.track}"`,
            );
          } else {
            report.tournamentsUpdated += 1;
          }
        } else {
          report.tournamentsCreated += 1;
        }

        for (const p of row.placements) {
          if (p.name === '?') {
            report.placementsSkipped += 1;
            continue;
          }
          report.placementsCreated += 1;
        }
      }
      return report;
    }

    const nameMap = await buildNameLookupMaps(track);
    const seriesCache = new Map<string, number>();
    const unmatched = new Set<string>();
    const sequelize = getSequelizeForModelGroup('tournaments');
    const rewardService = PlacementRewardService.getInstance();
    const creditService = PlacementCreditService.getInstance();

    for (const row of rows) {
      try {
        await sequelize.transaction(async transaction => {
          const seriesId = await ensureSeries(
            row.shortName,
            seriesCache,
            report.seriesCreated,
          );

          let tournament = await Tournament.findOne({
            where: {shortName: row.shortName},
            transaction,
          });

          if (tournament && tournament.track !== track) {
            throw new Error(
              `Tournament "${row.shortName}" already exists with track "${tournament.track}"`,
            );
          }

          const payload = {
            shortName: row.shortName,
            fullName: row.fullName || null,
            aka: row.aka || null,
            track,
            seriesId,
            status: row.isResultsFinal
              ? ('completed' as const)
              : row.isHidden
                ? ('ongoing' as const)
                : ('completed' as const),
            isHidden: row.isHidden,
            isResultsFinal: row.isResultsFinal,
            youtubeUrl: row.youtubeUrl || null,
            packRef: row.packRef || null,
            notes: row.notes || null,
            organizers: row.organizers.length ? row.organizers : null,
            sortYear: extractYear(row.shortName, row.fullName),
          };

          if (tournament) {
            await tournament.update(payload, {transaction});
            report.tournamentsUpdated += 1;
          } else {
            tournament = await Tournament.create(payload, {transaction});
            report.tournamentsCreated += 1;
          }

          if (replacePlacements) {
            await TournamentPlacement.destroy({
              where: {tournamentId: tournament.id},
              transaction,
            });
          }

          const tierByCode = new Map<string, TournamentTier>();
          const existingTiers = await TournamentTier.findAll({
            where: {tournamentId: tournament.id},
            transaction,
          });
          for (const t of existingTiers) {
            tierByCode.set(t.code.toUpperCase(), t);
          }

          const positionCounters = new Map<string, number>();

          for (const pair of row.placements) {
            const {code, withdrew} = parsePrizeCode(pair.prize);
            if (!code) {
              report.placementsSkipped += 1;
              continue;
            }

            const isPending = pair.name.trim() === '?';
            if (isPending || !pair.name.trim()) {
              report.placementsSkipped += 1;
              continue;
            }

            let tier = tierByCode.get(code);
            if (!tier) {
              const inferred = inferTierFromCode(code);
              tier = await TournamentTier.create(
                {
                  tournamentId: tournament.id,
                  code: inferred.code,
                  label: inferred.label,
                  kind: inferred.kind,
                  rankWeight: inferred.rankWeight,
                  sortOrder: inferred.sortOrder,
                },
                {transaction},
              );
              tierByCode.set(code, tier);
              report.tiersCreated += 1;
            }

            const pos = positionCounters.get(code) ?? 0;
            positionCounters.set(code, pos + 1);

            const linkedId = lookupNameId(nameMap, pair.name);
            if (linkedId) report.linked += 1;
            else unmatched.add(pair.name.trim());

            const placement = await TournamentPlacement.create(
              {
                tournamentId: tournament.id,
                tierId: tier.id,
                displayName: pair.name.trim(),
                playerId: track === 'player' ? linkedId : null,
                creatorId: track === 'creator' ? linkedId : null,
                withdrew,
                isPending: false,
                positionInTier: pos,
              },
              {transaction},
            );
            await creditService.ensureProfileCredit(placement, tournament, transaction);
            report.placementsCreated += 1;
          }
        });

        const tournament = await Tournament.findOne({
          where: {shortName: row.shortName},
        });
        if (tournament) {
          await rewardService.syncEntitlementsForTournament(tournament.id);
        }
      } catch (err: any) {
        report.errors.push(
          `${row.shortName}: ${err?.message || 'import failed'}`,
        );
      }
    }

    report.unmatchedNames = [...unmatched].sort((a, b) =>
      a.localeCompare(b, undefined, {sensitivity: 'base'}),
    );
    return report;
  }
}
