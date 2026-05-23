import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from '../models/User.model';

dotenv.config();

const makeAdmin = async (email: string) => {
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI is not defined in the environment variables.');
    }

    console.log(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);

    const user = await User.findOne({ email });
    if (!user) {
      console.error(`User with email ${email} not found.`);
      process.exit(1);
    }

    // Force the role field to exist and be 'admin'
    user.role = 'admin';
    await user.save();

    console.log(`\n✅ SUCCESS! User ${email} has been successfully upgraded to an 'admin'.`);
    console.log(`The 'role' field has been explicitly added to their database document.`);
    console.log(`You can now log into the Admin Panel!`);

    process.exit(0);
  } catch (error) {
    console.error('Error making user admin:', error);
    process.exit(1);
  }
};

const targetEmail = process.argv[2];

if (!targetEmail) {
  console.error('Please provide the email address of the user you want to make an admin.');
  console.error('Usage: npx ts-node src/scripts/makeAdmin.ts <email>');
  process.exit(1);
}

makeAdmin(targetEmail);
