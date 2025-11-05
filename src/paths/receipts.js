const {GoogleGenAI, createPartFromUri} = require('@google/genai');
const fs = require("node:fs/promises");
const path = require("node:path");
const mime = require("mime");
const express = require("express");
const multer = require("multer");

const { authenticate } = require("../utils/authMiddleware");
const { requireBody } = require("../utils/middleware");
const { db } = require("../utils/firebase");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/new-receipt",authenticate, requireBody, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Upload an image in 'image' field" });
    }
    const {userid} = req.body;
    if(!userid){
        return res.status(400).send({
            message: "no user id found"
        })
    }
    const result = await getVision(req.file.buffer);
    db.collection('receipts').doc().set({
        belongsto: userid, 
        createdAt: new Date().toISOString(),
        ...result
    })
    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RECEIPT_PROMPT = `
You are a receipt analyzer AI. Please extract the following JSON structure from this image:

{
  "items": [{"name": string, "price": number, "amount": number, "priceAfterTax": number, "priceAfterTaxAndGratuity":number}],
  "subtotal": number,
  "miscellaneous": [{"amount": number, "description": string}],
  "tax": number,
  "tip": number,
  "total": number,
  "store": string,
  "date": string,
  "classification": string
}
Return ONLY the JSON structure.
`;

/**
 * Accepts a local file path, Buffer, or a Web File/Blob.
 * 
 */
async function getVision(image) {
  // 1) Normalize to a Web File for upload
  let webFile;
  if (typeof image === "string") {
    const data = await fs.readFile(image);
    const filename = path.basename(image);
    const type = mime.getType(filename) || "application/octet-stream";
    webFile = new File([data], filename, { type });
  } else if (image instanceof Buffer) {
    webFile = new File([image], "receipt.jpg", { type: "image/jpeg" });
  } else {
    // File or Blob
    const name = (image).name ?? "image";
    const type = (image).type || "application/octet-stream";
    webFile = new File([image], name, { type });
  }

  // 2) Upload via Files API
  const upload = await ai.files.upload({
    file: webFile,
    displayName: (webFile).name || "receipt",
  });

  // 3) Wait until the file is fully processed and get its URI/mimeType
  let fileInfo = await ai.files.get({ name: upload.name });
  while (fileInfo.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 750));
    fileInfo = await ai.files.get({ name: upload.name });
  }

  // 4) Build a multimodal prompt: text + the uploaded image (by URI)
  const contents = [
    {
      role: "user",
      parts: [
        { text: RECEIPT_PROMPT },
        createPartFromUri(fileInfo.uri, fileInfo.mimeType),
      ],
    },
  ];

  // 5) Generate with JSON-only output
  const resp = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents,
    
    config: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      response_mime_type: "application/json",
    },
  });

  const text = resp.text; 
  console.log(text)
  return JSON.parse(textToJSON(text));
}

const textToJSON = (text) => {
    const t = text.replaceAll('`', "");
    const r = t.replace('json','');
    return r;
}

// GET /getallreceipts?page=1&userid=abc123
router.get("/getallreceipts", authenticate, requireBody, async (req, res) => {
  try {
    const pageRaw = req.query.page ?? req.body?.page ?? 1;
    const userid = (req.query.userid ?? req.body?.userid)?.toString().trim();

    if (!userid) {
      return res.status(400).send({ message: "no user id found" });
    }

    const page = Math.max(1, parseInt(pageRaw, 10) || 1);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;

    const baseQuery = db
      .collection("receipts")
      .where("belongsto", "==", userid);

    const countSnap = await baseQuery.count().get();
    const total = countSnap.data().count || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const snap = await baseQuery
      .orderBy("createdAt", "desc")
      .offset(offset)
      .limit(pageSize)
      .get();

    const receipts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    return res.status(200).json({
      page,
      pageSize,
      total,
      totalPages,
      receipts,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

module.exports = router