import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import https from 'https';

// Setup FFmpeg path automatically
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Extracts audio from a video buffer and returns the audio buffer.
 */
export const extractAudioFromVideo = (videoBuffer: Buffer): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const tempVideoPath = path.join(os.tmpdir(), `temp_vid_${crypto.randomBytes(8).toString('hex')}.mp4`);
    const tempAudioPath = path.join(os.tmpdir(), `temp_aud_${crypto.randomBytes(8).toString('hex')}.mp3`);

    fs.writeFileSync(tempVideoPath, videoBuffer);

    ffmpeg(tempVideoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .save(tempAudioPath)
      .on('end', () => {
        try {
          const audioBuffer = fs.readFileSync(tempAudioPath);
          fs.unlinkSync(tempVideoPath);
          fs.unlinkSync(tempAudioPath);
          resolve(audioBuffer);
        } catch (e) {
          reject(e);
        }
      })
      .on('error', (err) => {
        if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        reject(err);
      });
  });
};

/**
 * Downloads audio from a URL, removes original audio from video buffer, and merges them.
 */
export const mergeVideoWithAudioUrl = (videoBuffer: Buffer, audioUrl: string): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const tempVideoPath = path.join(os.tmpdir(), `temp_vid_${crypto.randomBytes(8).toString('hex')}.mp4`);
    const tempAudioPath = path.join(os.tmpdir(), `temp_aud_${crypto.randomBytes(8).toString('hex')}.mp3`);
    const tempOutputPath = path.join(os.tmpdir(), `temp_out_${crypto.randomBytes(8).toString('hex')}.mp4`);

    fs.writeFileSync(tempVideoPath, videoBuffer);

    // Download the audio file
    const file = fs.createWriteStream(tempAudioPath);
    https.get(audioUrl, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();

        // Merge video and downloaded audio
        ffmpeg()
          .input(tempVideoPath)
          .input(tempAudioPath)
          .outputOptions([
            '-c:v copy', // Copy video codec without re-encoding
            '-c:a aac',  // Encode audio to AAC
            '-map 0:v:0', // Use video from first input
            '-map 1:a:0', // Use audio from second input
            '-shortest'   // Cut to the shortest stream length
          ])
          .save(tempOutputPath)
          .on('end', () => {
            try {
              const mergedBuffer = fs.readFileSync(tempOutputPath);
              fs.unlinkSync(tempVideoPath);
              fs.unlinkSync(tempAudioPath);
              fs.unlinkSync(tempOutputPath);
              resolve(mergedBuffer);
            } catch (e) {
              reject(e);
            }
          })
          .on('error', (err) => {
            if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
            if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
            if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
            reject(err);
          });
      });
    }).on('error', (err) => {
      fs.unlinkSync(tempAudioPath);
      fs.unlinkSync(tempVideoPath);
      reject(err);
    });
  });
};
