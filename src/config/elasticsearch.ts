import { Client } from '@elastic/elasticsearch';
import { logger } from '../server/services/core/LoggerService.js';
import fs from 'fs';
import hash from 'object-hash';
import path from 'path';
import { writeFileAtomic } from '@/misc/utils/fs/fsSafeWrite.js';

// Read the CA certificate only in production
const isProduction = process.env.NODE_ENV === 'production';
let ca: Buffer | undefined;

if (isProduction) {
  const caPath = process.env.ELASTICSEARCH_CA_PATH || '/mnt/misc_volume_01/elasticsearch/elasticsearch-9.0.0/config/certs/ca/ca.crt';
  try {
    ca = fs.readFileSync(caPath);
  } catch (error) {
    logger.error('Failed to read Elasticsearch CA certificate:', error);
    throw error;
  }
}

const client = new Client({
  node: process.env.ELASTICSEARCH_URL || 'https://localhost:9200',
  auth: {
    username: process.env.ELASTICSEARCH_USERNAME || 'elastic',
    password: process.env.ELASTICSEARCH_PASSWORD || 'changeme'
  },
  tls: isProduction ? {
    rejectUnauthorized: true,
    ca: ca
  } : {
    rejectUnauthorized: false
  },
  maxRetries: 5,
  requestTimeout: 60000,
  sniffOnStart: true
});

// Index names
export const levelIndexName = 'levels_v1';
export const passIndexName = 'passes_v1';
export const playerIndexName = 'players_v1';
export const creatorIndexName = 'creators_v1';

// Alias names
export const levelAlias = 'levels';
export const passAlias = 'passes';
export const creditsAlias = 'credits';
export const playerAlias = 'players';
export const creatorAlias = 'creators';

// Combined index and alias configuration
const settings = {
  analysis: {
    analyzer: {
      custom_text_analyzer: {
        type: 'custom' as const,
        tokenizer: 'whitespace',
      },
      exact_match_analyzer: {
        type: 'custom' as const,
        tokenizer: 'keyword',
      }
    },
    normalizer: {
      lowercase_normalizer: {
        type: 'custom' as const,
        filter: ['lowercase'],
      },
    },
  }
}

export const levelMapping = {
  settings,
  mappings: {
    properties: {
      id: { type: 'integer' as const },
      bpm: { type: 'float' as const },
      tilecount: { type: 'integer' as const },
      levelLengthInMs: { type: 'float' as const },
      song: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          exact: {
            type: 'text' as const,
            analyzer: 'exact_match_analyzer'
          },
          keyword: {
            type: 'keyword' as const,
          }
        }
      },
      artist: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: {
            type: 'keyword' as const,
          }
        }
      },
      songId: { type: 'integer' as const },
      artistId: { type: 'integer' as const },
      suffix: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: { type: 'keyword' as const }
        }
      },
      songObject: {
        type: 'nested' as const,
        properties: {
          id: { type: 'integer' as const },
          name: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const }
            }
          },
          verificationState: { type: 'keyword' as const },
          aliases: {
            type: 'nested' as const,
            properties: {
              alias: {
                type: 'text' as const,
                analyzer: 'custom_text_analyzer',
                fields: {
                  keyword: { type: 'keyword' as const }
                }
              }
            }
          }
        }
      },
      artists: {
        type: 'nested' as const,
        properties: {
          id: { type: 'integer' as const },
          name: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const }
            }
          },
          avatarUrl: { type: 'text' as const },
          verificationState: { type: 'keyword' as const },
          role: { type: 'keyword' as const },
          aliases: {
            type: 'nested' as const,
            properties: {
              alias: {
                type: 'text' as const,
                analyzer: 'custom_text_analyzer',
                fields: {
                  keyword: { type: 'keyword' as const }
                }
              }
            }
          }
        }
      },
      primaryArtist: {
        type: 'nested' as const,
        properties: {
          id: { type: 'integer' as const },
          name: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const }
            }
          },
          avatarUrl: { type: 'text' as const },
          verificationState: { type: 'keyword' as const },
          aliases: {
            type: 'nested' as const,
            properties: {
              alias: {
                type: 'text' as const,
                analyzer: 'custom_text_analyzer',
                fields: {
                  keyword: { type: 'keyword' as const }
                }
              }
            }
          }
        }
      },
      team: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: {
            type: 'keyword' as const,
          }
        }
      },
      teamId: { type: 'integer' as const },
      diffId: { type: 'integer' as const },
      baseScore: { type: 'float' as const },
      ppBaseScore: { type: 'float' as const },
      previousBaseScore: { type: 'float' as const },
      videoLink: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: { type: 'keyword' as const }
        }
      },
      dlLink: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: { type: 'keyword' as const }
        }
      },
      legacyDllink: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: { type: 'keyword' as const }
        }
      },
      workshopLink: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: { type: 'keyword' as const }
        }
      },
      publicComments: {
        type: 'text' as const,
        fields: {
          keyword: { type: 'keyword' as const, ignore_above: 256 }
        }
      },
      toRate: { type: 'boolean' as const },
      rerateReason: {
        type: 'text' as const,
        fields: {
          keyword: { type: 'keyword' as const, ignore_above: 256 }
        }
      },
      rerateNum: {
        type: 'text' as const,
        fields: {
          keyword: { type: 'keyword' as const, ignore_above: 256 }
        }
      },
      previousDiffId: { type: 'long' as const },
      isAnnounced: { type: 'boolean' as const },
      isDeleted: { type: 'boolean' as const },
      isHidden: { type: 'boolean' as const },
      isExternallyAvailable: { type: 'boolean' as const },
      isCurated: { type: 'boolean' as const },
      createdAt: { type: 'date' as const },
      updatedAt: { type: 'date' as const },
      clears: { type: 'integer' as const },
      likes: { type: 'integer' as const },
      rating: {
        properties: {
          id: { type: 'integer' as const },
          levelId: { type: 'integer' as const },
          lowDiff: { type: 'boolean' as const },
          requesterFR: {
            type: 'text' as const,
            fields: {
              keyword: { type: 'keyword' as const, ignore_above: 256 }
            }
          },
          averageDifficultyId: { type: 'integer' as const },
          communityDifficultyId: { type: 'integer' as const },
          confirmedAt: { type: 'date' as const }
        }
      },
      difficulty: {
        properties: {
          id: { type: 'integer' as const },
          name: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          type: { type: 'keyword' as const },
          icon: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          emoji: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          color: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          createdAt: { type: 'date' as const },
          updatedAt: { type: 'date' as const },
          baseScore: { type: 'float' as const },
          sortOrder: { type: 'integer' as const },
          legacy: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          legacyIcon: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          legacyEmoji: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } }
        }
      },
      aliases: {
        type: 'nested' as const,
        properties: {
          field: { type: 'keyword' as const },
          originalValue: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: {
                type: 'keyword' as const,
              },
            },
          },
          alias: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: {
                type: 'keyword' as const,
              }
            }
          }
        }
      },
      levelCredits: {
        type: 'nested' as const,
        properties: {
          id: { type: 'long' as const },
          levelId: { type: 'long' as const },
          creatorId: { type: 'integer' as const },
          isOwner: { type: 'boolean' as const },
          role: {
            type: 'text' as const,
            fields: {
              keyword: { type: 'keyword' as const, ignore_above: 256 }
            }
          },
          creator: {
            type: 'nested' as const,
            properties: {
              id: { type: 'integer' as const },
              name: {
                type: 'text' as const,
                analyzer: 'custom_text_analyzer',
                fields: {
                  keyword: {
                    type: 'keyword' as const,
                  }
                }
              },
              userId: { type: 'keyword' as const },
              creatorAliases: {
                type: 'nested' as const,
                properties: {
                  id: { type: 'long' as const },
                  creatorId: { type: 'long' as const },
                  name: {
                    type: 'text' as const,
                    analyzer: 'custom_text_analyzer',
                    fields: {
                      keyword: {
                        type: 'keyword' as const,
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      teamObject: {
        type: 'nested' as const,
        properties: {
          id: { type: 'integer' as const },
          name: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
          },
          aliases: {
            type: 'nested' as const,
            properties: {
              id: { type: 'integer' as const },
              name: {
                type: 'text' as const,
                analyzer: 'custom_text_analyzer',
              }
            }
          }
        }
      },
      curations: {
        type: 'nested' as const,
        properties: {
            id: { type: 'integer' as const },
            levelId: { type: 'integer' as const },
            typeIds: { type: 'integer' as const },
            shortDescription: { type: 'text' as const },
            description: { type: 'text' as const },
            previewLink: { type: 'text' as const },
            customCSS: { type: 'text' as const },
            customColor: { type: 'text' as const },
            assignedBy: { type: 'text' as const },
            types: {
              type: 'nested' as const,
              properties: {
                id: { type: 'integer' as const },
                name: { type: 'text' as const },
                icon: { type: 'text' as const },
                color: { type: 'text' as const },
                group: { type: 'keyword' as const, ignore_above: 256 },
                groupSortOrder: { type: 'integer' as const },
                sortOrder: { type: 'integer' as const },
              }
            }
        }
      },
      tags: {
        type: 'nested' as const,
        properties: {
          id: { type: 'integer' as const },
          name: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const }
            }
          },
          icon: { type: 'text' as const },
          color: { type: 'keyword' as const },
          group: {
            type: 'text' as const,
            fields: {
              keyword: { type: 'keyword' as const, ignore_above: 256 }
            }
          }
        }
      }
    }
  }
};

export const passMapping = {
  settings,
  mappings: {
    properties: {
      id: { type: 'integer' as const },
      levelId: { type: 'integer' as const },
      playerId: { type: 'integer' as const },
      vidUploadTime: { type: 'date' as const },
      speed: { type: 'float' as const },
      feelingRating: { type: 'text' as const },
      vidTitle: { type: 'text' as const },
      videoLink: { type: 'text' as const },
      is12K: { type: 'boolean' as const },
      is16K: { type: 'boolean' as const },
      isNoHoldTap: { type: 'boolean' as const },
      accuracy: { type: 'float' as const },
      scoreV2: { type: 'float' as const },
      isDeleted: { type: 'boolean' as const },
      isAnnounced: { type: 'boolean' as const },
      isDuplicate: { type: 'boolean' as const },
      isWorldsFirst: { type: 'boolean' as const },
      player: {
        properties: {
          name: { type: 'text' as const, analyzer: 'custom_text_analyzer' },
          username: { type: 'text' as const, analyzer: 'custom_text_analyzer' },
          country: { type: 'keyword' as const },
          isBanned: { type: 'boolean' as const },
          avatarUrl: { type: 'text' as const }
        }
      },
      level: {
        properties: {
          song: { type: 'text' as const, analyzer: 'custom_text_analyzer' },
          artist: { type: 'text' as const, analyzer: 'custom_text_analyzer' },
          baseScore: { type: 'float' as const },
          diffId: { type: 'integer' as const },
          difficulty: {
            properties: {
              id: { type: 'integer' as const },
              name: { type: 'keyword' as const },
              type: { type: 'keyword' as const },
              sortOrder: { type: 'integer' as const }
            }
          },
          aliases: {
            type: 'nested' as const,
            properties: {
              alias: {
                type: 'text' as const,
                analyzer: 'custom_text_analyzer',
                fields: {
                  keyword: {
                    type: 'keyword' as const,
                  }
                }
              }
            }
          }
        }
      },
      judgements: {
        properties: {
          earlyDouble: { type: 'integer' as const },
          earlySingle: { type: 'integer' as const },
          ePerfect: { type: 'integer' as const },
          perfect: { type: 'integer' as const },
          lPerfect: { type: 'integer' as const },
          lateSingle: { type: 'integer' as const },
          lateDouble: { type: 'integer' as const }
        }
      }
    }
  }
};

export const playerMapping = {
  settings,
  mappings: {
    properties: {
      id: { type: 'integer' as const },
      name: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          exact: {
            type: 'text' as const,
            analyzer: 'exact_match_analyzer',
          },
          keyword: {
            type: 'keyword' as const,
          },
          lower: {
            type: 'keyword' as const,
            normalizer: 'lowercase_normalizer',
          },
        },
      },
      country: { type: 'keyword' as const },
      isBanned: { type: 'boolean' as const },
      isSubmissionsPaused: { type: 'boolean' as const },
      pfp: { type: 'keyword' as const },
      createdAt: { type: 'date' as const },
      updatedAt: { type: 'date' as const },
      user: {
        properties: {
          id: { type: 'keyword' as const },
          username: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const },
              lower: { type: 'keyword' as const, normalizer: 'lowercase_normalizer' },
            },
          },
          nickname: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const },
            },
          },
          avatarUrl: { type: 'keyword' as const },
          permissionFlags: { type: 'long' as const },
          permissionVersion: { type: 'integer' as const },
          isEmailVerified: { type: 'boolean' as const },
          creator: {
            properties: {
              id: { type: 'integer' as const },
              name: {
                type: 'text' as const,
                analyzer: 'custom_text_analyzer',
                fields: {
                  keyword: { type: 'keyword' as const },
                },
              },
              verificationStatus: { type: 'keyword' as const },
            },
          },
        },
      },
      discord: {
        properties: {
          username: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const },
              lower: { type: 'keyword' as const, normalizer: 'lowercase_normalizer' },
            },
          },
        },
      },
      // Aggregated stats (replaces player_stats table)
      rankedScore: { type: 'double' as const },
      generalScore: { type: 'double' as const },
      ppScore: { type: 'double' as const },
      wfScore: { type: 'double' as const },
      score12K: { type: 'double' as const },
      averageXacc: { type: 'float' as const },
      universalPassCount: { type: 'integer' as const },
      worldsFirstCount: { type: 'integer' as const },
      totalPasses: { type: 'integer' as const },
      // Denormalized top-diff info
      topDiffId: { type: 'integer' as const },
      topDiffSortOrder: { type: 'integer' as const },
      top12kDiffId: { type: 'integer' as const },
      top12kDiffSortOrder: { type: 'integer' as const },
      topDiff: {
        properties: {
          id: { type: 'integer' as const },
          name: { type: 'keyword' as const },
          type: { type: 'keyword' as const },
          sortOrder: { type: 'integer' as const },
          baseScore: { type: 'float' as const },
          icon: { type: 'keyword' as const },
          emoji: { type: 'keyword' as const },
          color: { type: 'keyword' as const },
          legacyIcon: { type: 'keyword' as const },
          legacyEmoji: { type: 'keyword' as const },
        },
      },
      top12kDiff: {
        properties: {
          id: { type: 'integer' as const },
          name: { type: 'keyword' as const },
          type: { type: 'keyword' as const },
          sortOrder: { type: 'integer' as const },
          baseScore: { type: 'float' as const },
          icon: { type: 'keyword' as const },
          emoji: { type: 'keyword' as const },
          color: { type: 'keyword' as const },
          legacyIcon: { type: 'keyword' as const },
          legacyEmoji: { type: 'keyword' as const },
        },
      },
      statsUpdatedAt: { type: 'date' as const },
    },
  },
};

export const creatorMapping = {
  settings,
  mappings: {
    properties: {
      id: { type: 'integer' as const },
      name: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          exact: {
            type: 'text' as const,
            analyzer: 'exact_match_analyzer',
          },
          keyword: {
            type: 'keyword' as const,
          },
          lower: {
            type: 'keyword' as const,
            normalizer: 'lowercase_normalizer',
          },
        },
      },
      verificationStatus: { type: 'keyword' as const },
      aliases: {
        type: 'nested' as const,
        properties: {
          id: { type: 'integer' as const },
          name: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const },
              lower: { type: 'keyword' as const, normalizer: 'lowercase_normalizer' },
            },
          },
        },
      },
      user: {
        properties: {
          id: { type: 'keyword' as const },
          username: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const },
              lower: { type: 'keyword' as const, normalizer: 'lowercase_normalizer' },
            },
          },
          nickname: {
            type: 'text' as const,
            analyzer: 'custom_text_analyzer',
            fields: {
              keyword: { type: 'keyword' as const },
            },
          },
          avatarUrl: { type: 'keyword' as const },
          playerId: { type: 'integer' as const },
        },
      },
      // Aggregated stats (per-role chart counts + denormalized totals)
      chartsCharted: { type: 'integer' as const },
      chartsVfxed: { type: 'integer' as const },
      chartsTeamed: { type: 'integer' as const },
      chartsTotal: { type: 'integer' as const },
      totalChartClears: { type: 'integer' as const },
      totalChartLikes: { type: 'integer' as const },
      // Placeholder for the C/O/V/H "highest role" icon (filled by a follow-up)
      topRole: { type: 'keyword' as const },
      createdAt: { type: 'date' as const },
      updatedAt: { type: 'date' as const },
      statsUpdatedAt: { type: 'date' as const },
    },
  },
};

export const indices = {
  [levelIndexName]: {
    alias: levelAlias,
    settings: levelMapping.settings,
    mappings: levelMapping.mappings
  },
  [passIndexName]: {
    alias: passAlias,
    settings: passMapping.settings,
    mappings: passMapping.mappings
  },
  [playerIndexName]: {
    alias: playerAlias,
    settings: playerMapping.settings,
    mappings: playerMapping.mappings
  },
  [creatorIndexName]: {
    alias: creatorAlias,
    settings: creatorMapping.settings,
    mappings: creatorMapping.mappings
  }
};

/** Payload hashed for levels index (settings + mappings only). */
const levelMappingHashPayload = {
  settings: levelMapping.settings,
  mappings: levelMapping.mappings
};

/** Payload hashed for passes index (settings + mappings only). */
const passMappingHashPayload = {
  settings: passMapping.settings,
  mappings: passMapping.mappings
};

/**
 * Payload hashed for players index (settings + mappings + indexer version).
 *
 * `indexerVersion` is bumped whenever the indexer *logic* changes in a way that
 * produces different documents without touching the ES mapping — e.g. fixing the
 * derived-stats SQL or adding denormalized fields. Bumping it forces
 * `reindexAllPlayers()` on the next boot while leaving the ES mapping alone.
 *
 * History:
 *   1 — initial release
 *   2 — 2026-04-17: fix topDiffId/top12kDiffId to resolve to Difficulty.id
 *       (was previously sortOrder, which collided with SPECIAL difficulties
 *       and produced wrong top diffs on denormalized docs).
 *   3 — 2026-04-19: denormalize `user.creator` when `users.creatorId` is set
 *       (mapping + indexer; clients read `playerData.user.creator`).
 */
const playerMappingHashPayload = {
  settings: playerMapping.settings,
  mappings: playerMapping.mappings,
  indexerVersion: 3,
};

/**
 * Payload hashed for creators index (settings + mappings + indexer version).
 *
 * `indexerVersion` is bumped whenever the indexer *logic* changes in a way that
 * produces different documents without touching the ES mapping. Bumping it forces
 * `reindexAllCreators()` on the next boot while leaving the ES mapping alone.
 *
 * History:
 *   1 — initial release
 *   2 — creator index mapping / document field set
 */
const creatorMappingHashPayload = {
  settings: creatorMapping.settings,
  mappings: creatorMapping.mappings,
  indexerVersion: 2,
};

const levelMappingHashPath = path.join(process.cwd(), 'mapping-hash-levels.json');
const passMappingHashPath = path.join(process.cwd(), 'mapping-hash-passes.json');
const playerMappingHashPath = path.join(process.cwd(), 'mapping-hash-players.json');
const creatorMappingHashPath = path.join(process.cwd(), 'mapping-hash-creators.json');

// Function to generate hash of mappings
export function generateMappingHash(mappings: any): string {
  return hash(mappings, {
    respectType: false,
    unorderedArrays: true,
    unorderedSets: true,
    unorderedObjects: true
  });
}

export async function updateMappingHash(opts: { reindexedLevels: boolean; reindexedPasses: boolean; reindexedPlayers: boolean; reindexedCreators: boolean }): Promise<void> {
  if (opts.reindexedLevels) {
    await storeLevelMappingHash(generateMappingHash(levelMappingHashPayload));
  }
  if (opts.reindexedPasses) {
    await storePassMappingHash(generateMappingHash(passMappingHashPayload));
  }
  if (opts.reindexedPlayers) {
    await storePlayerMappingHash(generateMappingHash(playerMappingHashPayload));
  }
  if (opts.reindexedCreators) {
    await storeCreatorMappingHash(generateMappingHash(creatorMappingHashPayload));
  }
}

function readHashFromFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return typeof data.hash === 'string' ? data.hash : null;
    }
  } catch (error) {
    logger.warn(`Failed to read mapping hash file ${filePath}:`, error);
  }
  return null;
}

async function writeHashFile(filePath: string, hashValue: string): Promise<void> {
  try {
    // Atomic write so a SIGKILL mid-write can't leave a half-written hash file that would later
    // be parsed as "no hash recorded" and trigger a spurious reindex on boot.
    await writeFileAtomic(
      filePath,
      JSON.stringify({ hash: hashValue, timestamp: new Date().toISOString() })
    );
  } catch (error) {
    logger.error(`Failed to store mapping hash file ${filePath}:`, error);
  }
}

export function readStoredLevelMappingHash(): string | null {
  return readHashFromFile(levelMappingHashPath);
}

export function readStoredPassMappingHash(): string | null {
  return readHashFromFile(passMappingHashPath);
}

export function readStoredPlayerMappingHash(): string | null {
  return readHashFromFile(playerMappingHashPath);
}

export function readStoredCreatorMappingHash(): string | null {
  return readHashFromFile(creatorMappingHashPath);
}

async function storeLevelMappingHash(hashValue: string): Promise<void> {
  await writeHashFile(levelMappingHashPath, hashValue);
}

async function storePassMappingHash(hashValue: string): Promise<void> {
  await writeHashFile(passMappingHashPath, hashValue);
}

async function storePlayerMappingHash(hashValue: string): Promise<void> {
  await writeHashFile(playerMappingHashPath, hashValue);
}

async function storeCreatorMappingHash(hashValue: string): Promise<void> {
  await writeHashFile(creatorMappingHashPath, hashValue);
}

export type ReindexFlags = {
  levelNeedsReindex: boolean;
  passNeedsReindex: boolean;
  playerNeedsReindex: boolean;
  creatorNeedsReindex: boolean;
};

async function isLevelIndexReady(): Promise<boolean> {
  const [idx, lvlAlias, credAlias] = await Promise.all([
    client.indices.exists({ index: levelIndexName }),
    client.indices.exists({ index: levelAlias }),
    client.indices.exists({ index: creditsAlias })
  ]);
  return Boolean(idx && lvlAlias && credAlias);
}

async function isPassIndexReady(): Promise<boolean> {
  const [idx, psAlias] = await Promise.all([
    client.indices.exists({ index: passIndexName }),
    client.indices.exists({ index: passAlias })
  ]);
  return Boolean(idx && psAlias);
}

async function isPlayerIndexReady(): Promise<boolean> {
  const [idx, plAlias] = await Promise.all([
    client.indices.exists({ index: playerIndexName }),
    client.indices.exists({ index: playerAlias })
  ]);
  return Boolean(idx && plAlias);
}

async function isCreatorIndexReady(): Promise<boolean> {
  const [idx, crAlias] = await Promise.all([
    client.indices.exists({ index: creatorIndexName }),
    client.indices.exists({ index: creatorAlias })
  ]);
  return Boolean(idx && crAlias);
}

// Function to check if reindexing is needed (per index)
export async function checkIfReindexingNeeded(): Promise<ReindexFlags> {
  try {
    const currentLevelHash = generateMappingHash(levelMappingHashPayload);
    const currentPassHash = generateMappingHash(passMappingHashPayload);
    const currentPlayerHash = generateMappingHash(playerMappingHashPayload);
    const currentCreatorHash = generateMappingHash(creatorMappingHashPayload);
    const storedLevelHash = readStoredLevelMappingHash();
    const storedPassHash = readStoredPassMappingHash();
    const storedPlayerHash = readStoredPlayerMappingHash();
    const storedCreatorHash = readStoredCreatorMappingHash();

    const levelHashMismatch = currentLevelHash !== storedLevelHash;
    const passHashMismatch = currentPassHash !== storedPassHash;
    const playerHashMismatch = currentPlayerHash !== storedPlayerHash;
    const creatorHashMismatch = currentCreatorHash !== storedCreatorHash;

    const [levelReady, passReady, playerReady, creatorReady] = await Promise.all([
      isLevelIndexReady(),
      isPassIndexReady(),
      isPlayerIndexReady(),
      isCreatorIndexReady(),
    ]);

    const levelNeedsReindex = levelHashMismatch || !levelReady;
    const passNeedsReindex = passHashMismatch || !passReady;
    const playerNeedsReindex = playerHashMismatch || !playerReady;
    const creatorNeedsReindex = creatorHashMismatch || !creatorReady;

    if (levelNeedsReindex || passNeedsReindex || playerNeedsReindex || creatorNeedsReindex) {
      logger.info(
        `Index configuration: levels reindex=${levelNeedsReindex} (hash=${levelHashMismatch}, ready=${levelReady}), passes reindex=${passNeedsReindex} (hash=${passHashMismatch}, ready=${passReady}), players reindex=${playerNeedsReindex} (hash=${playerHashMismatch}, ready=${playerReady}), creators reindex=${creatorNeedsReindex} (hash=${creatorHashMismatch}, ready=${creatorReady})`
      );
    }

    return { levelNeedsReindex, passNeedsReindex, playerNeedsReindex, creatorNeedsReindex };
  } catch (error) {
    logger.error('Error checking if reindexing is needed:', error);
    return { levelNeedsReindex: true, passNeedsReindex: true, playerNeedsReindex: true, creatorNeedsReindex: true };
  }
}

async function waitForElasticsearch(retries = 5, delay = 5000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const health = await client.cluster.health();
      if (health.status === 'green' || health.status === 'yellow') {
        logger.info('Elasticsearch is ready');
        return true;
      }
      logger.info(`Elasticsearch status: ${health.status}, waiting...`);
    } catch (error) {
      logger.warn(`Elasticsearch not ready (attempt ${i + 1}/${retries}):`, error);
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return false;
}

export type InitializeElasticsearchResult = {
  reindexedLevels: boolean;
  reindexedPasses: boolean;
  reindexedPlayers: boolean;
  reindexedCreators: boolean;
};

export async function initializeElasticsearch(): Promise<InitializeElasticsearchResult> {
  try {
    const isReady = await waitForElasticsearch();
    if (!isReady) {
      throw new Error('Elasticsearch failed to initialize after multiple retries');
    }

    const { levelNeedsReindex, passNeedsReindex, playerNeedsReindex, creatorNeedsReindex } = await checkIfReindexingNeeded();

    let reindexedLevels = false;
    let reindexedPasses = false;
    let reindexedPlayers = false;
    let reindexedCreators = false;

    if (levelNeedsReindex) {
      logger.info('Recreating levels index and aliases...');
      await client.indices
        .delete({
          index: [levelIndexName, levelAlias, creditsAlias],
          ignore_unavailable: true
        })
        .catch(() => {});

      const levelConfig = indices[levelIndexName];
      await client.indices.create({
        index: levelIndexName,
        settings: levelConfig.settings,
        mappings: levelConfig.mappings
      });
      logger.info(`Created index: ${levelIndexName}`);

      await client.indices.putAlias({
        index: levelIndexName,
        name: levelAlias
      });
      logger.info(`Created alias: ${levelAlias} -> ${levelIndexName}`);

      await client.indices.putAlias({
        index: levelIndexName,
        name: creditsAlias
      });
      logger.info(`Created alias: ${creditsAlias} -> ${levelIndexName}`);

      reindexedLevels = true;
    }

    if (passNeedsReindex) {
      logger.info('Recreating passes index and alias...');
      await client.indices
        .delete({
          index: [passIndexName, passAlias],
          ignore_unavailable: true
        })
        .catch(() => {});

      const passConfig = indices[passIndexName];
      await client.indices.create({
        index: passIndexName,
        settings: passConfig.settings,
        mappings: passConfig.mappings
      });
      logger.info(`Created index: ${passIndexName}`);

      await client.indices.putAlias({
        index: passIndexName,
        name: passAlias
      });
      logger.info(`Created alias: ${passAlias} -> ${passIndexName}`);

      reindexedPasses = true;
    }

    if (playerNeedsReindex) {
      logger.info('Recreating players index and alias...');
      await client.indices
        .delete({
          index: [playerIndexName, playerAlias],
          ignore_unavailable: true
        })
        .catch(() => {});

      const playerConfig = indices[playerIndexName];
      await client.indices.create({
        index: playerIndexName,
        settings: playerConfig.settings,
        mappings: playerConfig.mappings
      });
      logger.info(`Created index: ${playerIndexName}`);

      await client.indices.putAlias({
        index: playerIndexName,
        name: playerAlias
      });
      logger.info(`Created alias: ${playerAlias} -> ${playerIndexName}`);

      reindexedPlayers = true;
    }

    if (creatorNeedsReindex) {
      logger.info('Recreating creators index and alias...');
      await client.indices
        .delete({
          index: [creatorIndexName, creatorAlias],
          ignore_unavailable: true
        })
        .catch(() => {});

      const creatorConfig = indices[creatorIndexName];
      await client.indices.create({
        index: creatorIndexName,
        settings: creatorConfig.settings,
        mappings: creatorConfig.mappings
      });
      logger.info(`Created index: ${creatorIndexName}`);

      await client.indices.putAlias({
        index: creatorIndexName,
        name: creatorAlias
      });
      logger.info(`Created alias: ${creatorAlias} -> ${creatorIndexName}`);

      reindexedCreators = true;
    }

    if (!reindexedLevels && !reindexedPasses && !reindexedPlayers && !reindexedCreators) {
      logger.info('No index recreation needed');
    }

    return { reindexedLevels, reindexedPasses, reindexedPlayers, reindexedCreators };
  } catch (error) {
    logger.error('Error initializing Elasticsearch:', error);
    throw error;
  }
}

export default client;
