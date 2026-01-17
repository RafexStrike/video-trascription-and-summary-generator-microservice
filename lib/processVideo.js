// lib/processVideo.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import os from "os";
import util from "util";
import { exec as execCb } from "child_process";
import ffmpegStatic from "ffmpeg-static";

import { InferenceClient } from "@huggingface/inference";
import { createClient } from "@deepgram/sdk";

const exec = util.promisify(execCb);

// ---- Clients ----
if (!process.env.HF_TOKEN) throw new Error("HF_TOKEN not set");
if (!process.env.DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY not set");

const hf = new InferenceClient(process.env.HF_TOKEN);
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

/**
 * Extracts audio (wav 16k mono) from the videoPath,
 * transcribes using Deepgram,
 * summarizes using Hugging Face LLM.
 *
 * Returns: { transcription, summary }
 */
export async function processVideoFile(videoPath, ffmpegBin = undefined) {
  const tmpDir = os.tmpdir();
  const audioPath = path.join(tmpDir, `audio_${Date.now()}.wav`);

  // ---- ffmpeg setup ----
  let ff = ffmpegBin || ffmpegStatic || "ffmpeg";
  if (!ff) ff = "ffmpeg";
  console.log("Using ffmpeg binary:", ff);

  try {
    await exec(`"${ff}" -version`, { timeout: 5000 });
  } catch {
    throw new Error(`ffmpeg not found or not executable: ${ff}`);
  }

  // ---- Extract audio ----
  const ffmpegCmd =
    `"${ff}" -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`;

  try {
    console.log("Running ffmpeg:", ffmpegCmd);
    await exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 200 });
  } catch (err) {
    throw new Error("ffmpeg failed: " + (err?.stderr || err?.message));
  }

  // ---- Read audio ----
  let audioBuffer;
  try {
    audioBuffer = await fs.promises.readFile(audioPath);
  } catch (err) {
    throw new Error("Failed to read audio: " + err.message);
  }

  // =========================================================
  // 1) ASR — Deepgram (stable, production-grade)
  // =========================================================
  let transcription = "";
  try {
    console.log("Calling Deepgram ASR");

    const dgResponse = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: "nova-2",
        language: "en",
        smart_format: true,
        punctuate: true,
      }
    );

    transcription =
  dgResponse?.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";


    console.log("Transcription (trunc):", transcription.slice(0, 400));
  } catch (err) {
    console.error("ASR error:", err);
    throw new Error("ASR failed: " + err.message);
  }

  // =========================================================
  // 2) Summarization — Hugging Face LLM
  // =========================================================
  let summary = "";
  try {
    const prompt =
      `Summarize the transcript below into a concise summary (<= 3 sentences):\n\n${transcription}`;

    console.log("Calling InferenceClient.chatCompletion");

    const sumOut = await hf.chatCompletion({
      model: "NousResearch/Hermes-3-Llama-3.1-8B",
      messages: [{ role: "user", content: prompt }],
    });

    if (sumOut?.choices?.length) {
      summary = sumOut.choices[0].message?.content ?? "";
    }

    console.log("Summary (trunc):", summary.slice(0, 400));
  } catch (err) {
    console.error("Summary error:", err);
    summary = `Error generating summary: ${err.message}`;
  }

  // ---- Cleanup ----
  await fs.promises.unlink(audioPath).catch(() => {});

  return { transcription, summary };
}
