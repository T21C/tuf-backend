import { Client } from '@elastic/elasticsearch';
import { logger } from '../services/LoggerService.js';
import fs from 'fs';
import hash from 'object-hash';
import path from 'path';

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

// Alias names
export const levelAlias = 'levels';
export const passAlias = 'passes';
export const creditsAlias = 'credits';

// Combined index and alias configuration
const settings = {
  analysis: {
    analyzer: {
      custom_text_analyzer: {
        type: 'custom' as const,
        tokenizer: 'whitespace',
        filter: [
          'lowercase',
          'asciifolding'
        ]
      },
      exact_match_analyzer: {
        type: 'custom' as const,
        tokenizer: 'keyword',
        filter: [
          'lowercase',
          'asciifolding'
        ]
      }
    },
    normalizer: {
      lowercase: {
        type: 'custom' as const,
        filter: ['lowercase']
      }
    }
  }
}

export const levelMapping = {
  settings,
  mappings: {
    properties: {
      id: { type: 'integer' as const },
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
            normalizer: 'lowercase'
          }
        }
      },
      artist: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: {
            type: 'keyword' as const,
            normalizer: 'lowercase'
          }
        }
      },
      team: {
        type: 'text' as const,
        analyzer: 'custom_text_analyzer',
        fields: {
          keyword: {
            type: 'keyword' as const,
            normalizer: 'lowercase'
          }
        }
      },
      teamId: { type: 'integer' as const },
      diffId: { type: 'integer' as const },
      baseScore: { type: 'long' as const },
      previousBaseScore: { type: 'long' as const },
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
      isVerified: { type: 'boolean' as const },
      isExternallyAvailable: { type: 'boolean' as const },
      isCurated: { type: 'boolean' as const },
      createdAt: { type: 'date' as const },
      updatedAt: { type: 'date' as const },
      clears: { type: 'integer' as const },
      likes: { type: 'integer' as const },
      ratingAccuracy: { type: 'float' as const },
      totalRatingAccuracyVotes: { type: 'integer' as const },
      rating: {
        properties: {
          id: { type: 'integer' as const },
          levelId: { type: 'integer' as const },
          currentDifficultyId: { type: 'integer' as const },
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
          baseScore: { type: 'long' as const },
          sortOrder: { type: 'integer' as const },
          legacy: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          legacyIcon: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } },
          legacyEmoji: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const, ignore_above: 256 } } }
        }
      },
      aliases: {
        type: 'nested' as const,
        properties: {
          alias: { 
            type: 'text' as const,
            fields: {
              keyword: {
                type: 'keyword' as const,
                normalizer: 'lowercase'
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
          role: {
            type: 'text' as const,
            fields: {
              keyword: { type: 'keyword' as const, ignore_above: 256 }
            }
          },
          isVerified: { type: 'boolean' as const },
          creator: {
            type: 'nested' as const,
            properties: {
              id: { type: 'integer' as const },
              name: {
                type: 'text' as const,
                fields: {
                  keyword: {
                    type: 'keyword' as const,
                    normalizer: 'lowercase'
                  }
                }
              },
              createdAt: { type: 'date' as const },
              updatedAt: { type: 'date' as const },
              isVerified: { type: 'boolean' as const },
              userId: { type: 'keyword' as const },
              creatorAliases: {
                type: 'nested' as const,
                properties: {
                  id: { type: 'long' as const },
                  creatorId: { type: 'long' as const },
                  name: {
                    type: 'text' as const,
                    fields: {
                      keyword: {
                        type: 'keyword' as const,
                        normalizer: 'lowercase'
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
          name: { type: 'text' as const },
          createdAt: { type: 'date' as const },
          updatedAt: { type: 'date' as const },
          aliases: {
            type: 'nested' as const,
            properties: {
              id: { type: 'integer' as const },
              name: { type: 'text' as const }
            }
          }
        }
      },
      curation: {
        type: 'nested' as const,
        properties: {
            id: { type: 'integer' as const },
            levelId: { type: 'integer' as const },
            typeId: { type: 'integer' as const },
            shortDescription: { type: 'text' as const },
            description: { type: 'text' as const },
            previewLink: { type: 'text' as const },
            customCSS: { type: 'text' as const },
            customColor: { type: 'text' as const },
            assignedBy: { type: 'text' as const },
            createdAt: { type: 'date' as const },
            updatedAt: { type: 'date' as const },
            type: {
              type: 'nested' as const,
              properties: {
                id: { type: 'integer' as const },
                name: { type: 'text' as const },
                icon: { type: 'text' as const },
                color: { type: 'text' as const },
                createdAt: { type: 'date' as const },
                updatedAt: { type: 'date' as const }
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
          name: { type: 'text' as const },
          username: { type: 'text' as const },
          country: { type: 'keyword' as const },
          isBanned: { type: 'boolean' as const },
          avatarUrl: { type: 'text' as const }
        }
      },
      level: {
        properties: {
          song: { type: 'text' as const },
          artist: { type: 'text' as const },
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
                    normalizer: 'lowercase'
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
  }
};

// Function to generate hash of mappings
export function generateMappingHash(mappings: any): string {
  return hash(mappings, {
    respectType: false,
    unorderedArrays: true,
    unorderedSets: true,
    unorderedObjects: true
  });
}

export function updateMappingHash(): void {
  storeMappingHash(generateMappingHash(indices));
}

// Function to read stored mapping hash
export function readStoredMappingHash(): string | null {
  const hashPath = path.join(process.cwd(), 'mapping-hash.json');
  try {
    if (fs.existsSync(hashPath)) {
      const data = JSON.parse(fs.readFileSync(hashPath, 'utf8'));
      return data.hash;
    }
  } catch (error) {
    logger.warn('Failed to read mapping hash file:', error);
  }
  return null;
}

// Function to store mapping hash
export function storeMappingHash(hash: string): void {
  const hashPath = path.join(process.cwd(), 'mapping-hash.json');
  try {
    fs.writeFileSync(hashPath, JSON.stringify({ hash, timestamp: new Date().toISOString() }));
  } catch (error) {
    logger.error('Failed to store mapping hash:', error);
  }
}

// Function to check if reindexing is needed
export async function checkIfReindexingNeeded(): Promise<{ needsReindex: boolean }> {
  try {
    // Generate hash of the current index configuration
    const currentHash = generateMappingHash(indices);

    // Get stored hash
    const storedHash = readStoredMappingHash();

    // If hashes don't match, reindexing is needed
    if (currentHash !== storedHash) {
      logger.info('Index configuration has changed, reindexing needed');
      return { needsReindex: true };
    }

    logger.info('No reindexing needed, index configuration matches stored hash');
    return { needsReindex: false };
  } catch (error) {
    logger.error('Error checking if reindexing is needed:', error);
    // If we can't determine, assume reindexing is needed
    return { needsReindex: true };
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

export async function initializeElasticsearch() {
  try {
    const isReady = await waitForElasticsearch();
    if (!isReady) {
      throw new Error('Elasticsearch failed to initialize after multiple retries');
    }

    const { needsReindex } = await checkIfReindexingNeeded();
    const indexExists = await Promise.all([
      client.indices.exists({ index: levelIndexName }),
      client.indices.exists({ index: passIndexName }),
      client.indices.exists({ index: levelAlias }),
      client.indices.exists({ index: passAlias }),
      client.indices.exists({ index: creditsAlias })
    ]).then(results => results.every(Boolean));
    const doReindex = needsReindex || !indexExists;// || process.env.NODE_ENV === 'development';
    if (doReindex) {
      logger.info('Performing reindex...');

      // Delete any existing indices and aliases
      await client.indices.delete({
        index: [levelIndexName, passIndexName, levelAlias, passAlias, creditsAlias],
        ignore_unavailable: true
      }).catch(() => {});

      // Create indices with their mappings
      for (const [indexName, config] of Object.entries(indices)) {
        await client.indices.create({
          index: indexName,
          settings: config.settings,
          mappings: config.mappings
        });
        logger.info(`Created index: ${indexName}`);

        // Create alias
        await client.indices.putAlias({
          index: indexName,
          name: config.alias
        });
        logger.info(`Created alias: ${config.alias} -> ${indexName}`);
      }

      // Create credits alias pointing to levels index
      await client.indices.putAlias({
        index: levelIndexName,
        name: creditsAlias
      });
      logger.info(`Created alias: ${creditsAlias} -> ${levelIndexName}`);

      // Store new hash
      logger.info('Updated mapping hash stored');

    } else {
      logger.info('No mapping changes detected, skipping reindex');

    }
    return doReindex;

  } catch (error) {
    logger.error('Error initializing Elasticsearch:', error);
    throw error;
  }
}

export default client;
