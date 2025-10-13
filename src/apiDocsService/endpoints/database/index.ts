import { EndpointDefinition } from '../../services/DocumentationService.js';
import levelsEndpoints from './levels/index.js';
import passEndpoints from './passes/index.js';
import creatorsEndpoints from './creators.js';
import difficultiesEndpoints from './difficulties.js';
import leaderboardEndpoints from './leaderboard.js';
import playersEndpoints from './players.js';
import referencesEndpoints from './references.js';
import statisticsEndpoints from './statistics.js';

const databaseEndpoints: EndpointDefinition[] = [
  ...levelsEndpoints,
  ...passEndpoints,
  ...creatorsEndpoints,
  ...difficultiesEndpoints,
  ...leaderboardEndpoints,
  ...playersEndpoints,
  ...referencesEndpoints,
  ...statisticsEndpoints
];

export default databaseEndpoints;
