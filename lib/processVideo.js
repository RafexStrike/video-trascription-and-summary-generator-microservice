// lib/processVideo.js
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import os from "os";
import util from "util";
import { exec as execCb } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import fetch from "node-fetch"; // if using Node <18, install node-fetch; Node18+ has global fetch
import { InferenceClient } from "@huggingface/inference";

const exec = util.promisify(execCb);

// ---- create HF chat client (used for summarization) ----
// If you want to force using Hugging Face's own provider (avoid third-party providers),
// you can pass endpointUrl: "https://api-inference.huggingface.co" as second arg.
// const hf = new InferenceClient(process.env.HF_TOKEN, { endpointUrl: "https://api-inference.huggingface.co" });
if (!process.env.HF_TOKEN) throw new Error("HF_TOKEN not set in environment");
const hf = new InferenceClient(process.env.HF_TOKEN);

/**
 * Extracts audio (wav 16k mono) from the videoPath using ffmpeg,
 * calls Hugging Face Whisper REST endpoint for ASR,
 * then calls InferenceClient.chatCompletion for summarization.
 *
 * Returns: { transcription, summary }
 */
export async function processVideoFile(videoPath, ffmpegBin = undefined) {
  const tmpDir = os.tmpdir();
  const audioPath = path.join(tmpDir, `audio_${Date.now()}.wav`);

  // Resolve ffmpeg binary
  let ff = ffmpegBin || ffmpegStatic || "ffmpeg";
  if (!ff) ff = "ffmpeg";
  console.log("Using ffmpeg binary:", ff);

  // Verify ffmpeg exists (best-effort; spawn will still fail if wrong)
  try {
    await exec(`"${ff}" -version`, { timeout: 5000 });
  } catch (err) {
    console.error("ffmpeg check failed:", err?.message || err);
    throw new Error(`ffmpeg not found or not executable: ${ff}`);
  }

  // Extract audio
  const ffmpegCmd = `"${ff}" -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}"`;
  try {
    console.log("Running ffmpeg:", ffmpegCmd);
    await exec(ffmpegCmd, { maxBuffer: 1024 * 1024 * 200 });
  } catch (err) {
    const stderr = err?.stderr || err?.message || String(err);
    console.error("ffmpeg failed:", stderr);
    throw new Error("ffmpeg failed: " + stderr);
  }

  // Read audio bytes
  let audioBuffer;
  try {
    audioBuffer = await fs.promises.readFile(audioPath);
  } catch (e) {
    await fs.promises.unlink(audioPath).catch(() => {});
    throw new Error("Failed to read audio: " + (e?.message || e));
  }

  // --- 1) ASR (Whisper) via HF REST (this worked for you before) ---
  let transcription = "";
  try {
    const asrUrl =
      "https://api-inference.huggingface.co/models/openai/whisper-large-v3";
    console.log("Calling REST ASR endpoint:", asrUrl);

    const res = await fetch(asrUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "audio/wav", // important
      },
      body: audioBuffer,
    });

    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(
        "ASR HTTP error",
        res.status,
        res.statusText,
        raw.slice(0, 2000)
      );
      throw new Error(
        `HF ASR failed: ${res.status} ${res.statusText} - ${raw.slice(0, 1000)}`
      );
    }

    // parse typical responses
    let asrJson;
    try {
      asrJson = raw ? JSON.parse(raw) : null;
    } catch (e) {
      asrJson = raw;
    }
    if (!asrJson) transcription = "";
    else if (typeof asrJson === "string") transcription = asrJson;
    else if (asrJson.text) transcription = asrJson.text;
    else if (asrJson.transcription) transcription = asrJson.transcription;
    else if (Array.isArray(asrJson) && asrJson[0]?.text)
      transcription = asrJson[0].text;
    else transcription = JSON.stringify(asrJson);

    console.log("Transcription (trunc):", transcription.slice(0, 400));
  } catch (err) {
    await fs.promises.unlink(audioPath).catch(() => {});
    console.error("ASR error:", err);
    throw new Error("ASR failed: " + (err?.message || err));
  }

  // --- 2) Summarization using InferenceClient.chatCompletion ---
  let summary = "";
  try {
    const prompt = `Summarize the transcript below into a concise summary (<= 3 sentences):\n\n${transcription}`;
    console.log("Calling InferenceClient.chatCompletion for summarization");

    const sumOut = await hf.chatCompletion({
      model: "NousResearch/Hermes-3-Llama-3.1-8B",
      messages: [{ role: "user", content: prompt }],
    });

    // normalize response shapes
    if (sumOut?.choices && sumOut.choices.length > 0) {
      const c = sumOut.choices[0];
      if (c.message?.content) summary = c.message.content;
      else if (c.text) summary = c.text;
      else if (c.generated_text) summary = c.generated_text;
      else summary = JSON.stringify(c);
    } else if (typeof sumOut === "string") summary = sumOut;
    else if (sumOut?.generated_text) summary = sumOut.generated_text;
    else summary = JSON.stringify(sumOut);

    console.log("Summary (trunc):", (summary || "").slice(0, 400));
  } catch (err) {
    console.error("Summary error:", err);
    summary = `Error generating summary: ${err?.message || err}`;
  }

  // cleanup temp audio
  await fs.promises.unlink(audioPath).catch(() => {});

  return { transcription, summary };
}
