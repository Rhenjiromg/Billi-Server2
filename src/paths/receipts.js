const {GoogleGenAI, createPartFromUri} = require('@google/genai');
const fs = require("node:fs/promises");
const path = require("node:path");
const mime = require("mime");
const express = require("express");
const multer = require("multer");

const { authenticate } = require("../utils/authMiddleware");
const { requireBody } = require("../utils/middleware");
const { db } = require("../utils/firebase");
const { type } = require('node:os');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/new-receipt",authenticate, upload.single("image"), async (req, res) => {
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
    const docRef = db.collection('receipts').doc();
    await docRef.set({
        belongsto: userid, 
        createdAt: new Date().toISOString(),
        ...result
    })
    return res.status(200).send({
        id: docRef.id,
        result:result});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RECEIPT_PROMPT = `
You are a receipt analyzer AI. Please extract the following JSON structure from this image:

{
  "items": [{"name": string, "price": number, "amount": number, "individualPrice":number, "priceAfterTax": number, "priceAfterTaxAndGratuity":number, "assignedTo": null}],
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

router.post('/assign-receipt', authenticate, requireBody, async(req, res) => {
  try{
    const {userid, receiptid, receipt} = req.body;
    if(!userid || !receipt || !receiptid){
      return res.status(400).send({
        message: 'not all required fields are found.'
      })
    }

    const docRef = db.collection('receipts').doc(receiptid);
    await docRef.update(receipt);

    return res.status(200).send();

  }catch(error){
    console.error(error);
    return res.status(500).send({
      message: error
    })
  }
});

router.get('/get-per-person', authenticate, requireBody, async(req, res) => {
  try{
    const {userid, receiptid} = req.body;
    if(!userid || !receiptid){
      return res.status(400).send({
        message: 'missing request form'
      })
    }
    const receipt = await db.collection('receipts').doc(receiptid).get();
    if(!receipt.exists){
      return res.status(404).send({
        message: 'receipt not found!'
      })
    }
    const t = calculate(receipt);
    return res.status(200).send(t);
  }catch(error){
    console.error(error)
  }
})

/**
 * Calculate how much each person owes on a receipt.
 * - Distributes tax, tip, and miscellaneous amounts proportionally by each person's pre-tax item total.
 * - Rounds to cents and fixes any rounding pennies so the sum equals receipt.total.
 * - Supports `assignedTo` as a string, an array of strings (split evenly), or null (goes to "_unassigned").
 *
 * @param {Object} receipt
 * @returns {{
 *   perPerson: {
 *     [person: string]: {
 *       items: Array<{ name: string, qty: number, lineTotal: number }>,
 *       preTaxSubtotal: number,
 *       taxShare: number,
 *       tipShare: number,
 *       miscShare: number,
 *       totalOwed: number
 *     }
 *   },
 *   check: { computedTotal: number, receiptTotal: number, difference: number }
 * }}
 */
const calculate = (receipt) => {
  // --- Helpers ---
  const toCents = (n) => Math.round((Number(n) || 0) * 100);
  const fromCents = (c) => Number((c / 100).toFixed(2));

  // Normalize misc to cents
  const miscTotalCents = toCents(
    (Array.isArray(receipt.miscellaneous) ? receipt.miscellaneous : []).reduce(
      (sum, m) => sum + (Number(m?.amount) || 0),
      0
    )
  );

  // Build item lines and figure out per-person pre-tax subtotals (in cents)
  const perPerson = {}; // person -> accumulator
  const ensurePerson = (name) => {
    const key = name ?? "_unassigned";
    if (!perPerson[key]) {
      perPerson[key] = {
        items: [],
        preTaxSubtotalCents: 0,
        taxShareCents: 0,
        tipShareCents: 0,
        miscShareCents: 0,
        totalOwedCents: 0,
      };
    }
    return key;
  };

  const items = Array.isArray(receipt.items) ? receipt.items : [];
  for (const item of items) {
    const qty = Number(item?.amount) || 0;
    const unit = Number(item?.price) || 0;
    const baseLine = qty * unit; // pre-tax
    const baseLineCents = toCents(baseLine);
    if (baseLineCents === 0) continue;

    // assignedTo can be string | array<string> | null/undefined
    let assignees = item?.assignedTo;
    if (assignees == null || assignees === "") {
      assignees = ["_unassigned"];
    } else if (Array.isArray(assignees)) {
      assignees = assignees.filter(Boolean);
      if (assignees.length === 0) assignees = ["_unassigned"];
    } else {
      assignees = [String(assignees)];
    }

    // Split the line evenly across assignees (if multiple)
    const shareEach = Math.floor(baseLineCents / assignees.length);
    let remainder = baseLineCents - shareEach * assignees.length;

    assignees.forEach((person, idx) => {
      const key = ensurePerson(person);
      const add = shareEach + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;

      perPerson[key].preTaxSubtotalCents += add;
      perPerson[key].items.push({
        name: item?.name ?? "Item",
        qty,
        lineTotal: fromCents(add),
      });
    });
  }

  const taxCents = toCents(receipt.tax);
  const tipCents = toCents(receipt.tip);
  const subtotalProvidedCents = toCents(receipt.subtotal);
  const totalProvidedCents = toCents(receipt.total);

  // Compute pre-tax subtotal from items if not provided (or use provided if it matches)
  const computedPreTaxSubtotalCents = Object.values(perPerson).reduce(
    (s, p) => s + p.preTaxSubtotalCents,
    0
  );
  const preTaxSubtotalCents =
    subtotalProvidedCents > 0 ? subtotalProvidedCents : computedPreTaxSubtotalCents;

  const weightingSubtotalCents =
    computedPreTaxSubtotalCents > 0 ? computedPreTaxSubtotalCents : preTaxSubtotalCents;

  // Distribute shared charges (tax, tip, misc) proportionally by pre-tax share
  const sharedPools = [
    { key: "taxShareCents", amount: taxCents },
    { key: "tipShareCents", amount: tipCents },
    { key: "miscShareCents", amount: miscTotalCents },
  ];

  // Prepare weights and handle zero-subtotal case
  const people = Object.keys(perPerson).length ? Object.keys(perPerson) : [ensurePerson("_unassigned")];
  const weights = people.map((person) => {
    const w = perPerson[person].preTaxSubtotalCents;
    return { person, weight: w };
  });

  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);

  // If no one has items (edge-case), allocate everything to _unassigned
  if (totalWeight === 0) {
    const key = ensurePerson("_unassigned");
    perPerson[key].preTaxSubtotalCents = 0;
    // all shared charges remain to be allocated below as zeros; we’ll set them directly
    perPerson[key].taxShareCents = taxCents;
    perPerson[key].tipShareCents = tipCents;
    perPerson[key].miscShareCents = miscTotalCents;
  } else {
    for (const pool of sharedPools) {
      // First pass: proportional allocation, floor to cents, track remainders
      let allocated = 0;
      const remainders = [];

      for (const { person, weight } of weights) {
        const raw = (pool.amount * weight) / totalWeight;
        const cents = Math.floor(raw); // floor
        const rem = raw - cents;
        perPerson[person][pool.key] += cents;
        allocated += cents;
        remainders.push({ person, rem });
      }

      // Distribute leftover pennies by largest remainders
      let leftover = pool.amount - allocated;
      remainders
        .sort((a, b) => b.rem - a.rem)
        .slice(0, leftover)
        .forEach(({ person }) => {
          perPerson[person][pool.key] += 1;
        });
    }
  }

  // Compute per-person totals (cents)
  let sumOfPeopleCents = 0;
  for (const person of Object.keys(perPerson)) {
    const p = perPerson[person];
    p.totalOwedCents = p.preTaxSubtotalCents + p.taxShareCents + p.tipShareCents + p.miscShareCents;
    sumOfPeopleCents += p.totalOwedCents;
  }

  const inferredTotalCents =
    preTaxSubtotalCents + taxCents + tipCents + miscTotalCents;
  const targetTotalCents = totalProvidedCents > 0 ? totalProvidedCents : inferredTotalCents;

  let diff = targetTotalCents - sumOfPeopleCents; 
  if (diff !== 0) {
    const order = Object.keys(perPerson)
      .map((person) => {
        const w = perPerson[person].preTaxSubtotalCents;
        const frac = w - Math.floor(w); 
        const prop = totalWeight ? w / totalWeight : 0;
        return { person, prop };
      })
      .sort((a, b) => b.prop - a.prop || a.person.localeCompare(b.person))
      .map(({ person }) => person);

    let i = 0;
    while (diff !== 0 && order.length > 0) {
      const person = order[i % order.length];
      perPerson[person].totalOwedCents += diff > 0 ? 1 : -1;
      diff += diff > 0 ? -1 : 1;
      i++;
    }
    sumOfPeopleCents = Object.values(perPerson).reduce((s, p) => s + p.totalOwedCents, 0);
  }

  // Build final, pretty output
  const pretty = {};
  for (const [person, p] of Object.entries(perPerson)) {
    pretty[person] = {
      items: p.items,
      preTaxSubtotal: fromCents(p.preTaxSubtotalCents),
      taxShare: fromCents(p.taxShareCents),
      tipShare: fromCents(p.tipShareCents),
      miscShare: fromCents(p.miscShareCents),
      totalOwed: fromCents(p.totalOwedCents),
    };
  }

  return {
    perPerson: pretty,
    check: {
      computedTotal: fromCents(sumOfPeopleCents),
      receiptTotal: fromCents(targetTotalCents),
      difference: fromCents(sumOfPeopleCents - targetTotalCents),
    },
  };
};


module.exports = router