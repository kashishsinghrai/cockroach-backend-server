import mongoose, { Document, Schema } from 'mongoose';

export interface IPost extends Document {
  author: mongoose.Types.ObjectId;
  content: string;
  mediaUrls: string[];
  videoUrl?: string;
  mediaType: 'image' | 'video' | 'text';
  audioUrl?: string; // Extracted MP3 URL
  originalAudioId?: mongoose.Types.ObjectId; // Reference to the original post that provided the audio
  likes: mongoose.Types.ObjectId[];
  likesCount: number;
  repostsCount: number;
  commentsCount: number;
  replySetting: 'everyone' | 'following' | 'mentioned';
  poll?: {
    question: string;
    options: { text: string; votes: number }[];
    votedUsers: Map<string, number>;
  };
  // For reposts
  isRepost: boolean;
  originalPost?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PostSchema: Schema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, default: '', maxlength: 500 },
    mediaUrls: [{ type: String }],
    videoUrl: { type: String, required: false },
    audioUrl: { type: String, required: false },
    originalAudioId: { type: Schema.Types.ObjectId, ref: 'Post', required: false },
    mediaType: { type: String, enum: ['image', 'video', 'text'], default: 'text' },
    // Rationale: We store the array of likes (ObjectIds) to know *who* liked a post.
    // However, for feed rendering, counting array length is slow for thousands of posts.
    // Therefore, we denormalize the count into `likesCount` which is updated atomically via $inc.
    replySetting: { type: String, enum: ['everyone', 'following', 'mentioned'], default: 'everyone' },
    poll: {
      question: { type: String },
      options: [{ text: String, votes: { type: Number, default: 0 } }],
      votedUsers: { type: Map, of: Number }, // Map of user Id strings to option index
    },
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    likesCount: { type: Number, default: 0, min: 0 },
    repostsCount: { type: Number, default: 0, min: 0 },
    commentsCount: { type: Number, default: 0, min: 0 },
    isRepost: { type: Boolean, default: false },
    originalPost: { type: Schema.Types.ObjectId, ref: 'Post' },
  },
  { timestamps: true }
);

// Index for fast feed queries
PostSchema.index({ author: 1, createdAt: -1 });

export default mongoose.model<IPost>('Post', PostSchema);
