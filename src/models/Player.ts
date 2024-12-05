import mongoose, { Schema, Document } from 'mongoose';

export interface IPlayer extends Document {
  id: number;
  name: string;
  country: string;
  isBanned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const playerSchema = new Schema({
  id: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  country: {
    type: String,
    required: true,
    index: true
  },
  isBanned: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

export default mongoose.model<IPlayer>('Player', playerSchema);