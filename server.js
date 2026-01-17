// server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import multer from "multer";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { processVideoFile } from "./lib/processVideo.js";
import cors from "cors";

const app = express();

console.log(process.env.HF_TOKEN);


// Hard coded CORS starts...
const corsOptions = {
  origin: [
    "http://localhost:3000", 
    "https://ph-team-code-spirit-quick-clip.vercel.app", 
    "https://luminal-ai.vercel.app"
 
  ],
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Hard coded CORS ends...

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max 
});

const PORT = process.env.PORT || 3002;

app.post("/process", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "video file required" });

  // Save to tmp
  const tmpDir = os.tmpdir();
  const filename = `upload_${Date.now()}.mp4`;
  const videoPath = path.join(tmpDir, filename);

  try {
    await fs.writeFile(videoPath, req.file.buffer);
    console.log("Saved upload to", videoPath);

    // processVideoFile returns { transcription, summary }
    const result = await processVideoFile(videoPath);
    // cleanup
    await fs.unlink(videoPath).catch(() => {});
    return res.json(result);
  } catch (err) {
    console.error("Processing failed:", err);
    // attempt cleanup
    await fs.unlink(videoPath).catch(() => {});
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Video processor running" });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
