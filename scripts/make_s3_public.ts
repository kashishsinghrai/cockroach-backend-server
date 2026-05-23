import "dotenv/config";
declare const process: any;
declare const console: any;
import { S3Client, PutPublicAccessBlockCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";

/**
 * Automates fixing the S3 bucket policy to allow public reads for uploaded media.
 */
async function makeS3Public() {
  const bucketName = "cockroach-media-bucket-2026";
  const client = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
  });

  console.log(`[S3 FIX] Starting policy update for bucket: ${bucketName}...`);

  try {
    // 1. Unblock public access
    const publicAccessCmd = new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    });

    console.log(`[S3 FIX] Disabling "Block Public Access"...`);
    await client.send(publicAccessCmd);
    console.log(`[S3 FIX] ✅ Public access unblocked.`);

    // 2. Put bucket policy for public reads
    const bucketPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicReadGetObject",
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
      ],
    };

    const bucketPolicyCmd = new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(bucketPolicy),
    });

    console.log(`[S3 FIX] Applying PublicReadGetObject policy...`);
    await client.send(bucketPolicyCmd);
    console.log(`[S3 FIX] ✅ Bucket policy applied.`);
    
    console.log(`[S3 FIX] 🎉 Done. Media uploads will now be publicly accessible.`);
  } catch (error) {
    console.error(`[S3 FIX] ❌ Failed:`, error);
    process.exit(1);
  }
}

makeS3Public();
