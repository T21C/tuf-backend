import searchEndpoints from './search.js';
import announcementsEndpoints from './announcements.js';
import aliasesEndpoints from './aliases.js';
import aprilFoolsEndpoints from './aprilFools.js';
import modificationEndpoints from './modification.js';

const levelsEndpoints = [
  ...searchEndpoints,
  ...announcementsEndpoints,
  ...aliasesEndpoints,
  ...aprilFoolsEndpoints,
  ...modificationEndpoints
];

export default levelsEndpoints; 