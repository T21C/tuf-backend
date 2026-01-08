const SEPARATORS = [' & ', ' | ', ', '];

interface ParsedCredits {
  charters: string[];
  vfxers: string[];
  team?: string;
  teamMembers?: string[];
}

export function parseCredits(
  team: string,
  charter: string,
  vfxer: string,
): ParsedCredits {
  const credits: ParsedCredits = {
    charters: [],
    vfxers: [],
    team: undefined,
    teamMembers: [],
  };

  // Helper function to split names considering multiple separators
  const splitNames = (str: string): string[] => {
    let names = [str];
    for (const separator of SEPARATORS) {
      names = names.flatMap(name => name.split(separator));
    }
    return names.map(name => name.trim()).filter(Boolean);
  };

  // Parse team name and members if present
  if (team) {
    // Common team indicators
    const teamIndicators = [' team', ' Team', ' TEAM'];
    let teamName = team;
    let members: string[] = [];

    // Check if team name contains member list
    const memberListStart = team.indexOf('(');
    const memberListEnd = team.lastIndexOf(')');

    if (memberListStart !== -1 && memberListEnd !== -1) {
      // Extract team name and member list
      teamName = team.substring(0, memberListStart).trim();
      const memberList = team.substring(memberListStart + 1, memberListEnd);
      members = splitNames(memberList);
    }

    // Clean up team name
    teamIndicators.forEach(indicator => {
      if (teamName.endsWith(indicator)) {
        teamName = teamName.slice(0, -indicator.length).trim();
      }
    });

    credits.team = teamName;
    credits.teamMembers = members;
  }

  credits.charters = splitNames(charter);
  credits.vfxers = splitNames(vfxer);

  return credits;
}
