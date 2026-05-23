import mongoose, { Document, Schema } from 'mongoose';

export interface IStory extends Document {
  author: mongoose.Types.ObjectId;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  thumbnailUrl?: string; // Optional if we generate it for video stories later
  viewers: mongoose.Types.ObjectId[];
  createdAt: Date;
  expiresAt: Date;
}

const StorySchema: Schema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mediaUrl: { type: String, required: true },
    mediaType: { type: String, enum: ['image', 'video'], required: true },
    thumbnailUrl: { type: String },
    viewers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now },
    // TTL Index: This tells MongoDB to automatically delete the document when the current time reaches expiresAt
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
);

// Index for quickly fetching active stories by author
StorySchema.index({ author: 1, expiresAt: 1 });

export default mongoose.model<IStory>('Story', StorySchema);
