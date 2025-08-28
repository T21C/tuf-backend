export const permissionFlags = {
  SUPER_ADMIN: 1n << 62n,        
  RATER: 1n << 61n,              
  BANNED: 1n << 60n,             
  SUBMISSIONS_PAUSED: 1n << 59n, 
  RATING_BANNED: 1n << 58n,      
  HEAD_CURATOR: 1n << 32n,       
  CURATOR: 1n << 31n,            
  EMAIL_VERIFIED: 1n << 0n,      
};

export const curationTypeAbilities = {
  // Basic abilities
  CUSTOM_CSS: 1n << 0n,
  CURATOR_ASSIGNABLE: 1n << 6n,          // Can only be assigned by curator leads/admins
  RATER_ASSIGNABLE: 1n << 7n,            // Can only be assigned by raters
  
  SHOW_ASSIGNER: 1n << 10n,            // Show who assigned on hover
  FORCE_DESCRIPTION: 1n << 11n,        // Require description when assigned
  FRONT_PAGE_ELIGIBLE: 1n << 13n,      // Can appear on front page
  CUSTOM_COLOR_THEME: 1n << 14n,       // Allows custom color theming

  LEVEL_LIST_BASIC_GLOW: 1n << 15n,
  LEVEL_LIST_LEGENDARY_GLOW: 1n << 16n,
} as const;


export const validSortOptions = [
  'rankedScore',
  'generalScore',
  'ppScore',
  'wfScore',
  'score12K',
  'universalPassCount',
  'averageXacc',
  'worldsFirstCount',
  'totalPasses',
  'topDiff',
  'top12kDiff',
  'player',
];

export const PGU_SORT = {
  P: 1,
  G: 2,
  U: 3,
};
export type PguLetter = 'P' | 'G' | 'U';
