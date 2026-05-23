import mongoose, { Document, Schema } from 'mongoose';

export interface IFollowerGraph extends Document {
  followerId: mongoose.Types.ObjectId;
  followingId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const FollowerGraphSchema: Schema = new Schema(
  {
    followerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    followingId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// Compound unique index prevents duplicate follows
FollowerGraphSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
// Index for fast "who is this user following?" queries
FollowerGraphSchema.index({ followerId: 1 });
// Index for fast "who follows this user?" queries
FollowerGraphSchema.index({ followingId: 1 });

export default mongoose.model<IFollowerGraph>('FollowerGraph', FollowerGraphSchema);
