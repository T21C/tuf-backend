import mongoose, { Schema, Document } from 'mongoose';

export interface IPlayer extends Document {
  name: string;
  country: string;
  isBanned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const playerSchema = new Schema({
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
  timestamps: true // Adds createdAt and updatedAt fields
});

export default mongoose.model<IPlayer>('Player', playerSchema);