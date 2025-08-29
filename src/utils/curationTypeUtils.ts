import { Op } from 'sequelize';
import sequelize from '../config/db.js';
import { curationTypeAbilities } from '../config/constants.js';
import { permissionFlags } from '../config/constants.js';
import { Transaction } from 'sequelize';
import CurationType from '../models/curations/CurationType.js';
import { Literal } from 'sequelize/lib/utils';

export type CurationTypeInput = bigint | number | CurationType | null | undefined;

/**
 * Extract abilities from various input types
 */
const extractAbilities = (input: CurationTypeInput): bigint => {
  if (input instanceof CurationType && input !== null && input !== undefined) {
    // If it's a curation type object, use abilities
    if ('abilities' in input && input.abilities !== undefined) {
      return BigInt(input.abilities || 0);
    }
  }
  
  // If it's a number or bigint, convert to bigint
  return BigInt((input || 0) as number);
};

/**
 * Check if a curation type has a specific ability
 * @param curationType - Curation type object or abilities
 * @param ability - Ability flag to check
 */
export const hasAbility = (curationType: CurationTypeInput, ability: bigint): boolean => {
  const abilities = extractAbilities(curationType);
  return (abilities & ability) === ability;
};

/**
 * Check if a curation type has any of the specified abilities
 * @param curationType - Curation type object or abilities
 * @param abilities - Array of ability flags to check
 */
export const hasAnyAbility = (curationType: CurationTypeInput, abilities: bigint[]): boolean => {
  const typeAbilities = extractAbilities(curationType);
  return abilities.some(ability => (typeAbilities & ability) === ability);
};

/**
 * Check if a curation type has all of the specified abilities
 * @param curationType - Curation type object or abilities
 * @param abilities - Array of ability flags to check
 */
export const hasAllAbilities = (curationType: CurationTypeInput, abilities: bigint[]): boolean => {
  const typeAbilities = extractAbilities(curationType);
  return abilities.every(ability => (typeAbilities & ability) === ability);
};

/**
 * Add an ability to a curation type's abilities
 * @param curationType - Curation type object or abilities
 * @param ability - Ability flag to add
 */
export const addAbility = (curationType: CurationTypeInput, ability: bigint): bigint => {
  const abilities = extractAbilities(curationType);
  return abilities | ability;
};

/**
 * Remove an ability from a curation type's abilities
 * @param curationType - Curation type object or abilities
 * @param ability - Ability flag to remove
 */
export const removeAbility = (curationType: CurationTypeInput, ability: bigint): bigint => {
  const abilities = extractAbilities(curationType);
  return abilities & ~ability;
};

/**
 * Check if a user can assign a curation type based on their permissions
 * @param userFlags - User's permission flags
 * @param curationAbilities - Curation type's abilities
 */
export const canAssignCurationType = (userFlags: bigint, curationAbilities: bigint): boolean => {
  // Super admins can assign all curation types
  if ((userFlags & permissionFlags.SUPER_ADMIN) !== 0n 
  || (userFlags & permissionFlags.HEAD_CURATOR) !== 0n) {
    return true;
  }

  // Check for CURATOR_ASSIGNABLE ability
  if (hasAbility(curationAbilities, curationTypeAbilities.CURATOR_ASSIGNABLE)) {
    return (userFlags & permissionFlags.CURATOR) !== 0n;
  }

  // Check for RATER_ASSIGNABLE ability
  if (hasAbility(curationAbilities, curationTypeAbilities.RATER_ASSIGNABLE)) {
    return (userFlags & permissionFlags.RATER) !== 0n;
  }
  
  // If no specific assignment flag, only super admins can assign
  return false;
};

/**
 * Get the default color for a curation type based on its abilities
 * @param abilities - Curation type abilities
 */
export const getDefaultColor = (abilities: bigint): string => {
  if (hasAbility(abilities, curationTypeAbilities.CUSTOM_COLOR_THEME)) {
    return '#e0e0e0'; // Light gray for custom theme
  }
  
  return '#ffffff'; // Default white
};

/**
 * Get hover information for a curation type
 * @param curation - Curation object with type and metadata
 */
export const getHoverInfo = (curation: any): string => {
  const info: string[] = [];
  
  if (hasAbility(curation.type?.abilities, curationTypeAbilities.SHOW_ASSIGNER)) {
    info.push(`By: ${curation.assignedBy || 'Unknown'}`);
  }
  
  return info.join(' | ');
};

/**
 * Create a Sequelize where clause for checking if a curation type has a specific ability
 */
export const whereHasAbility = (ability: bigint): Literal => {
  return sequelize.literal(`(abilities & ${ability}) = ${ability}`);
};

/**
 * Create a Sequelize where clause for checking if a curation type has any of the specified abilities
 */
export const whereHasAnyAbility = (abilities: bigint[]): any => {
  const conditions = abilities.map(ability => 
    sequelize.literal(`(abilities & ${ability}) = ${ability}`)
  );
  return {
    [Op.or]: conditions
  };
};

/**
 * Create a Sequelize where clause for checking if a curation type has all of the specified abilities
 */
export const whereHasAllAbilities = (abilities: bigint[]): any => {
  const conditions = abilities.map(ability => 
    sequelize.literal(`(abilities & ${ability}) = ${ability}`)
  );
  return {
    [Op.and]: conditions
  };
};

/**
 * Set or unset a specific ability for a curation type
 * @param curationType - Curation type model instance or attributes
 * @param ability - The ability flag to set/unset
 * @param value - true to add the ability, false to remove it
 * @returns The new abilities value
 */
export const setCurationTypeAbility = (curationType: CurationType, ability: bigint, value: boolean): bigint => {
  const currentAbilities = extractAbilities(curationType);
  
  if (value) {
    return addAbility(currentAbilities, ability);
  } else {
    return removeAbility(currentAbilities, ability);
  }
};

/**
 * Set or unset a specific ability for a curation type and update the database
 * @param curationType - Curation type model instance
 * @param ability - The ability flag to set/unset
 * @param value - true to add the ability, false to remove it
 * @param transaction - Optional database transaction
 * @returns Promise that resolves when the update is complete
 */
export const setCurationTypeAbilityAndSave = async (
  curationType: CurationType, 
  ability: bigint, 
  value: boolean, 
  transaction?: Transaction
): Promise<void> => {
  const newAbilities = setCurationTypeAbility(curationType, ability, value);
  await curationType.update({ 
    abilities: newAbilities
  }, { transaction });
};
