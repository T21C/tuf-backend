import mongoose, { Schema, Document } from 'mongoose';

export interface ILevel extends Document {
  id: number;
  song: string;
  artist: string;
  creator: string;
  charter: string;
  vfxer: string;
  team: string;
  diff: number;
  legacyDiff: number;
  pguDiff: string;
  pguDiffNum: number;
  newDiff: number;
  pdnDiff: number;
  realDiff: number;
  baseScore: number;
  baseScoreDiff: string;
  isCleared: boolean;
  clears: number;
  vidLink: string;
  dlLink: string;
  workshopLink: string;
  publicComments: string;
  toRate: boolean;
  rerateReason: string;
  rerateNum: string;
}

const LevelSchema = new Schema<ILevel>({
  id: { type: Number, required: true },
  song: { type: String, default: "" },
  artist: { type: String, default: "" },
  creator: { type: String, default: "" },
  charter: { type: String, default: "" },
  vfxer: { type: String, default: "" },
  team: { type: String, default: "" },
  diff: { type: Number, default: 0 },
  legacyDiff: { type: Number, default: 0 },
  pguDiff: { type: String, default: "" },
  pguDiffNum: { type: Number, default: 0 },
  newDiff: { type: Number, default: 0 },
  pdnDiff: { type: Number, default: 0 },
  realDiff: { type: Number, default: 0 },
  baseScore: { type: Number, default: 0 },
  baseScoreDiff: { type: String, default: "" },
  isCleared: { type: Boolean, default: false },
  clears: { type: Number, default: 0 },
  vidLink: { type: String, default: "" },
  dlLink: { type: String, default: "" },
  workshopLink: { type: String, default: "" },
  publicComments: { type: String, default: "" },
  toRate: { type: Boolean, default: false },
  rerateReason: { type: String, default: "" },
  rerateNum: { type: String, default: "" }
});

export default mongoose.model<ILevel>('Level', LevelSchema); 