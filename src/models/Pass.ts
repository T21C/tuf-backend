import mongoose, { Schema, Document } from 'mongoose';
import { IJudgements } from './Judgements';

export interface IPass extends Document {
  id: number;
  levelId: number;
  speed: number | null;
  player: string;
  feelingRating: string;
  vidTitle: string;
  vidLink: string;
  vidUploadTime: Date;
  is12K: boolean;
  is16K: boolean;
  isNoHoldTap: boolean;
  isLegacyPass: boolean;
  judgements: IJudgements;
  accuracy: number;
  scoreV2: number;
}

const passSchema = new Schema<IPass>({
  id: { 
    type: Number, 
    required: true, 
    unique: true 
  },
  levelId: { 
    type: Number, 
    required: true 
  },
  speed: { 
    type: Number, 
    default: null 
  },
  player: { 
    type: String, 
    required: true 
  },
  feelingRating: { 
    type: String, 
    default: "" 
  },
  vidTitle: { 
    type: String, 
    required: true 
  },
  vidLink: { 
    type: String, 
    required: true 
  },
  vidUploadTime: { 
    type: Date, 
    required: true 
  },
  is12K: { 
    type: Boolean, 
    default: false 
  },
  is16K: { 
    type: Boolean, 
    default: false 
  },
  isNoHoldTap: { 
    type: Boolean, 
    default: false 
  },
  isLegacyPass: { 
    type: Boolean, 
    default: false 
  },
  judgements: {
    earlyDouble: { type: Number, required: true },
    earlySingle: { type: Number, required: true },
    ePerfect: { type: Number, required: true },
    perfect: { type: Number, required: true },
    lPerfect: { type: Number, required: true },
    lateSingle: { type: Number, required: true },
    lateDouble: { type: Number, required: true }
  },
  accuracy: { 
    type: Number, 
    required: true 
  },
  scoreV2: { 
    type: Number, 
    required: true 
  }
});

export default mongoose.model<IPass>('Pass', passSchema, 'passes'); 