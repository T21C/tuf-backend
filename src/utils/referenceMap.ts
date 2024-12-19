import Reference from '../models/References';
import Difficulty from '../models/Difficulty';
import { IDifficulty } from '../interfaces/models';
import { Transaction } from 'sequelize';

export const referenceMap = [
  { difficultyName: 'P1', levelIds: [3001, 2998, 2999, 3034] },
  { difficultyName: 'P2', levelIds: [3000, 3002, 3035] },
  { difficultyName: 'P3', levelIds: [3037, 3064, 3105, 3106] },
  { difficultyName: 'P4', levelIds: [3005, 3007, 6490] },
  { difficultyName: 'P5', levelIds: [3065, 3134, 6491] },
  { difficultyName: 'P6', levelIds: [6501, 4004, 3107] },
  { difficultyName: 'P7', levelIds: [3011, 6498, 3130] },
  { difficultyName: 'P8', levelIds: [3068, 6505, 4291] },
  { difficultyName: 'P9', levelIds: [3073, 3044, 5653] },
  { difficultyName: 'P10', levelIds: [3046, 3066] },
  { difficultyName: 'P11', levelIds: [6523, 3013, 3092] },
  { difficultyName: 'P12', levelIds: [3101, 3048] },
  { difficultyName: 'P13', levelIds: [3144, 3054, 3091] },
  { difficultyName: 'P14', levelIds: [3053, 3080, 3111] },
  { difficultyName: 'P15', levelIds: [3079, 3085, 3093] },
  { difficultyName: 'P16', levelIds: [3072, 3147, 3120] },
  { difficultyName: 'P17', levelIds: [3057, 3083, 2971] },
  { difficultyName: 'P18', levelIds: [2334, 1796, 3082] },
  { difficultyName: 'P19', levelIds: [1640, 1650, 1652, 1654] },
  { difficultyName: 'P20', levelIds: [1684, 1685, 1668, 1662] },
  { difficultyName: 'G1', levelIds: [711, 1141, 967, 925] },
  { difficultyName: 'G2', levelIds: [1078, 3861, 1145, 743] },
  { difficultyName: 'G3', levelIds: [703, 710, 691, 1174] },
  { difficultyName: 'G4', levelIds: [658, 896, 572, 768] },
  { difficultyName: 'G5', levelIds: [756, 883, 1018, 629] },
  { difficultyName: 'G6', levelIds: [853, 627, 698] },
  { difficultyName: 'G7', levelIds: [605, 674, 564, 869] },
  { difficultyName: 'G8', levelIds: [924, 5333, 628, 650] },
  { difficultyName: 'G9', levelIds: [1007, 747, 615, 3619] },
  { difficultyName: 'G10', levelIds: [2010, 574, 1843, 529] },
  { difficultyName: 'G11', levelIds: [512, 625, 868, 469] },
  { difficultyName: 'G12', levelIds: [938, 1255, 1964] },
  { difficultyName: 'G13', levelIds: [870, 451, 2881, 878] },
  { difficultyName: 'G14', levelIds: [2309, 1167, 489, 467] },
  { difficultyName: 'G15', levelIds: [365, 1542, 357, 352] },
  { difficultyName: 'G16', levelIds: [873, 1036, 375, 359] },
  { difficultyName: 'G17', levelIds: [207, 191, 197, 223] },
  { difficultyName: 'G18', levelIds: [203, 30, 185, 210] },
  { difficultyName: 'G19', levelIds: [144, 141, 89, 256] },
  { difficultyName: 'G20', levelIds: [94, 331, 229, 151] },
  { difficultyName: 'U1', levelIds: [45, 115, 2247, 24] },
  { difficultyName: 'U2', levelIds: [2620, 5880, 974, 31] },
  { difficultyName: 'U3', levelIds: [12, 1834, 253, 90] },
  { difficultyName: 'U4', levelIds: [1, 1502, 106, 3] },
  { difficultyName: 'U5', levelIds: [418, 60, 15, 6] },
  { difficultyName: 'U6', levelIds: [10, 2238, 235, 2101] },
  { difficultyName: 'U7', levelIds: [252, 7, 1221, 4] },
  { difficultyName: 'U8', levelIds: [1954, 449, 20, 1559] },
  { difficultyName: 'U9', levelIds: [40, 43, 2856] },
  { difficultyName: 'U10', levelIds: [36, 1527, 1537, 274] },
  { difficultyName: 'U11', levelIds: [1069, 2976] },
  { difficultyName: 'U12', levelIds: [1059, 2884] },
  { difficultyName: 'U13', levelIds: [2467] },
  { difficultyName: 'U14', levelIds: [] },
];

export async function initializeReferences(difficulties: IDifficulty[], transaction: Transaction) {
  try {
    // Clear existing references
    await Reference.destroy({ where: {} });

    console.log("Starting to create references");
    
    const diffNameToId = new Map(difficulties.map(d => [d.name, d.id]));
    // Create flattened reference documents
    const referenceDocs = referenceMap.flatMap(ref => {
      const difficultyId = diffNameToId.get(ref.difficultyName);
      if (!difficultyId) {
        console.warn(`No difficulty ID found for ${ref.difficultyName}`);
        return [];
      }

      return ref.levelIds.map(levelId => ({
        difficultyId,
        levelId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    });

    console.log(`Creating ${referenceDocs.length} references`);
    await Reference.bulkCreate(referenceDocs, { transaction });
    console.log('References initialized successfully');
  } catch (error) {
    console.error('Error initializing references:', error);
    throw error;
  }
} 