import fs from 'fs';
import path from 'path';
import { logger } from '../../services/LoggerService.js';
import JSON5 from 'json5';

interface LevelData {
    settings: {
        requiredMods?: string[];
        songFilename?: string;
        [key: string]: any;
    };
    [key: string]: any;
}

interface LevelAnalysis {
    isValid: boolean;
    hasYouTubeStream: boolean;
    error?: string;
    details?: {
        settings?: any;
        [key: string]: any;
    };
}

export class LevelService {
    /**
     * Reads and parses a level file from disk
     * @param levelPath Path to the .adofai file
     * @returns Parsed level data
     */
    static async readLevelFile(levelPath: string): Promise<LevelData> {
        try {
            logger.info('Reading level file:', { levelPath });

            // Check if file exists
            if (!fs.existsSync(levelPath)) {
                throw new Error('Level file not found');
            }

            // Read file as buffer first to handle potential encoding issues
            const buffer = await fs.promises.readFile(levelPath);
            
            // Try to detect and remove BOM if present
            let content = buffer;
            if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
                content = buffer.slice(3);
            }

            // Convert to string and perform initial cleanup
            let jsonString = content.toString('utf8')
                .replace(/^\uFEFF/, '') // Remove BOM if still present
                .replace(/\r\n/g, '\n') // Normalize line endings
                .replace(/\r/g, '\n')   // Handle any remaining \r
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
                // Add trailing commas to arrays and objects
                .replace(/([}\]])[\s\n]*([}\]])/g, '$1,$2') // Add comma between closing brackets
                .replace(/([}\]])[\s\n]*("decorations"|"actions"|"settings")/g, '$1,$2') // Add comma before main sections
                .trim();

            // Function to safely parse JSON with multiple fallback strategies
            const safeParseJSON = (str: string): any => {
                // Strategy 1: Try direct JSON5 parse
                try {
                    return JSON5.parse(str);
                } catch (e) {
                    logger.debug('Initial JSON5 parse failed, trying cleanup strategies');
                }

                try {
                    const cleaned = str
                        .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas before closing brackets
                        .replace(/([}\]])[\s\n]*([}\]])/g, '$1,$2') // Ensure comma between closing brackets
                        .replace(/([}\]])[\s\n]*("decorations"|"actions"|"settings")/g, '$1,$2'); // Ensure comma before main sections
                    
                    return JSON5.parse(cleaned);
                } catch (e) {
                    logger.debug('Cleaned JSON5 parse failed, trying manual parsing');
                }

                // Strategy 3: Manual parsing for critical fields
                try {
                    // Extract settings object using regex
                    const settingsMatch = str.match(/"settings"\s*:\s*({[^}]+})/);
                    if (!settingsMatch) {
                        throw new Error('Could not find settings object');
                    }

                    // Create a minimal valid JSON structure
                    const minimalJSON: LevelData = {
                        settings: {
                            requiredMods: [],
                            songFilename: '',
                            artist: '',
                            song: '',
                            author: '',
                            difficulty: '',
                            bpm: ''
                        }
                    };

                    // Extract requiredMods if present
                    const modsMatch = str.match(/"requiredMods"\s*:\s*\[([^\]]*)\]/);
                    if (modsMatch) {
                        minimalJSON.settings.requiredMods = modsMatch[1]
                            .split(',')
                            .map(mod => mod.trim().replace(/"/g, ''))
                            .filter(Boolean);
                    }

                    // Extract songFilename if present
                    const songMatch = str.match(/"songFilename"\s*:\s*"([^"]+)"/);
                    if (songMatch) {
                        minimalJSON.settings.songFilename = songMatch[1];
                    }

                    // Extract other common settings
                    const commonSettings = ['artist', 'song', 'author', 'difficulty', 'bpm'] as const;
                    commonSettings.forEach(setting => {
                        const match = str.match(new RegExp(`"${setting}"\\s*:\\s*"([^"]+)"`));
                        if (match) {
                            minimalJSON.settings[setting] = match[1];
                        }
                    });

                    return minimalJSON;
                } catch (e) {
                    logger.error('All parsing strategies failed:', {
                        error: e instanceof Error ? e.message : String(e),
                        levelPath,
                        fileSize: buffer.length
                    });
                    throw new Error('Failed to parse level file with all strategies');
                }
            };

            // Attempt to parse the JSON
            const levelData = safeParseJSON(jsonString);
            
            // Validate the parsed data has required structure
            if (!levelData || typeof levelData !== 'object' || !levelData.settings) {
                throw new Error('Invalid level file structure');
            }

            return levelData;
        } catch (error) {
            logger.error('Error reading level file:', {
                error: error instanceof Error ? error.message : String(error),
                levelPath
            });
            throw error;
        }
    }

    /**
     * Analyzes a level object and returns its properties
     * @param levelData Parsed level data object
     * @returns LevelAnalysis object containing validation results
     */
    static analyzeLevelData(levelData: LevelData): LevelAnalysis {
        try {
            // Check for required settings
            if (!levelData.settings) {
                logger.error('Level data missing settings');
                return {
                    isValid: false,
                    hasYouTubeStream: false,
                    error: 'Level data missing settings'
                };
            }

            // Check for YouTube stream requirement
            const hasYouTubeStream = Array.isArray(levelData.settings.requiredMods) && 
                                   levelData.settings.requiredMods.includes('YouTubeStream');


            return {
                isValid: true,
                hasYouTubeStream,
                details: {
                    settings: levelData.settings
                }
            };
        } catch (error) {
            logger.error('Error analyzing level data:', {
                error: error instanceof Error ? error.message : String(error)
            });
            return {
                isValid: false,
                hasYouTubeStream: false,
                error: 'Failed to analyze level data'
            };
        }
    }

    /**
     * Analyzes a level file and returns its properties
     * @param levelPath Path to the .adofai file
     * @returns LevelAnalysis object containing validation results
     */
    static async analyzeLevel(levelPath: string): Promise<LevelAnalysis> {
        try {
            const levelData = await this.readLevelFile(levelPath);
            return this.analyzeLevelData(levelData);
        } catch (error) {
            return {
                isValid: false,
                hasYouTubeStream: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Validates if a level file meets all requirements
     * @param levelPath Path to the .adofai file
     * @returns true if level is valid, false otherwise
     */
    static async validateLevel(levelPath: string): Promise<boolean> {
        const analysis = await this.analyzeLevel(levelPath);
        return analysis.isValid;
    }

    /**
     * Checks if a level requires YouTube stream
     * @param levelPath Path to the .adofai file
     * @returns true if level requires YouTube stream, false otherwise
     */
    static async requiresYouTubeStream(levelPath: string): Promise<boolean> {
        const analysis = await this.analyzeLevel(levelPath);
        return analysis.hasYouTubeStream;
    }
} 