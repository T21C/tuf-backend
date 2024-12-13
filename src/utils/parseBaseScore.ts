import { ILevel } from "../interfaces/models";

export function getBaseScore(level: ILevel): number {
    const baseScore = level.baseScore ? level.baseScore : level.difficulty?.baseScore ?? 0;
    return baseScore;
}
