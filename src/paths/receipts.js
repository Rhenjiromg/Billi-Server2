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
const admin = require('firebase-admin');
const { Filter } = require('firebase-admin/firestore');

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
    const receiptRef = db.collection('receipts').doc();
    const userRef = db.collection('users').doc(userid);

    const batch = db.batch();

    batch.set(receiptRef,{
      belongsto: userid,
      createdAt: new Date().toISOString(), 
      isDeleted: false, 
      ...result
    })

        batch.set(
        userRef,
        {
          receipts: admin.firestore.FieldValue.arrayUnion(receiptRef.id),
          receiptCount: admin.firestore.FieldValue.increment(1),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      await batch.commit();
    return res.status(200).send({
        id: receiptRef.id,
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
  
  let webFile;
  if (typeof image === "string") {
    const data = await fs.readFile(image);
    const filename = path.basename(image);
    const type = mime.getType(filename) || "application/octet-stream";
    webFile = new File([data], filename, { type });
  } else if (image instanceof Buffer) {
    webFile = new File([image], "receipt.jpg", { type: "image/jpeg" });
  } else {
    
    const name = (image).name ?? "image";
    const type = (image).type || "application/octet-stream";
    webFile = new File([image], name, { type });
  }

  
  const upload = await ai.files.upload({
    file: webFile,
    displayName: (webFile).name || "receipt",
  });

  
  let fileInfo = await ai.files.get({ name: upload.name });
  while (fileInfo.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 750));
    fileInfo = await ai.files.get({ name: upload.name });
  }

  
  const contents = [
    {
      role: "user",
      parts: [
        { text: RECEIPT_PROMPT },
        createPartFromUri(fileInfo.uri, fileInfo.mimeType),
      ],
    },
  ];

  
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


router.get("/getallreceipts", authenticate, async (req, res) => {
  try {
    const userid = (req.query.userid || "").toString().trim();
    if (!userid) {
      return res.status(400).json({ message: "no user id found" });
    }

    
    const userSnap = await db.collection("users").doc(userid).get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: "user not found" });
    }

    
    const userData = userSnap.data() || {};
    const receiptIds = Array.isArray(userData.receipts)
      ? userData.receipts.filter((x) => typeof x === "string")
      : [];

    if (receiptIds.length === 0) {
      return res.status(200).json({ receipts: [] });
    }

    
    const chunk = (arr, size = 300) =>
      Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size)
      );

    
    const allSnaps = [];
    for (const ids of chunk(receiptIds, 300)) {
      const refs = ids.map((id) => db.collection("receipts").doc(id));
      const snaps = await db.getAll(...refs);
      allSnaps.push(...snaps);
    }

    
    const receipts = allSnaps
      .filter((s) => s.exists)
      .map((s) => {
        const data = s.data() || {};
        const createdAt =
          data.createdAt?.toDate?.() instanceof Date
            ? data.createdAt.toDate().toISOString()
            : data.createdAt ?? null;

        return {
          id: s.id,
          createdAt,
          store: data.store ?? data.merchant ?? null,
          total: data.total ?? null,
        };
      })
      
      .sort((a, b) => {
        const ta = a.createdAt ? +new Date(a.createdAt) : 0;
        const tb = b.createdAt ? +new Date(b.createdAt) : 0;
        return tb - ta;
      });

    return res.status(200).json({ receipts });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ error: error?.message || "Unknown error" });
  }
});

router.post('/assign-receipt', authenticate, async (req, res) => {
  try {
    const { userid, receiptid, receipt } = req.body;

    if (!userid || !receiptid || !receipt || !Array.isArray(receipt.items)) {
      return res.status(400).send({ message: 'userid, receiptid, and receipt.items (array) are required.' });
    }

    console.log(userid);

    const docRef = db.collection('receipts').doc(receiptid);

    
    await docRef.update({ items: receipt.items });

    return res.sendStatus(200);
  } catch (error) {
    console.error(error);
    return res.status(500).send({ message: String(error) });
  }
});

router.post('/get-per-person', authenticate, requireBody, async(req, res) => {
  try{
    const { receiptid} = req.body;
    if( !receiptid){
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
    const t = calculate(receipt.data());
    console.log(t);
    return res.status(200).send(t);
  }catch(error){
    console.error(error)
  }
})

const calculate = (receipt) => {
  
  const toCents = (n) => Math.round((Number(n) || 0) * 100);
  const fromCents = (c) => Number((c / 100).toFixed(2));

  
  const miscTotalCents = toCents(
    (Array.isArray(receipt.miscellaneous) ? receipt.miscellaneous : []).reduce(
      (sum, m) => sum + (Number(m?.amount) || 0),
      0
    )
  );

  
  const perPerson = {}; 
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
    const baseLine = unit; 
    const baseLineCents = toCents(baseLine);
    if (baseLineCents === 0) continue;

    
    let assignees = item?.assignedTo;
    if (assignees == null || assignees === "") {
      assignees = ["_unassigned"];
    } else if (Array.isArray(assignees)) {
      assignees = assignees.filter(Boolean);
      if (assignees.length === 0) assignees = ["_unassigned"];
    } else {
      assignees = [String(assignees)];
    }

    
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

  
  const computedPreTaxSubtotalCents = Object.values(perPerson).reduce(
    (s, p) => s + p.preTaxSubtotalCents,
    0
  );
  const preTaxSubtotalCents =
    subtotalProvidedCents > 0 ? subtotalProvidedCents : computedPreTaxSubtotalCents;

  const weightingSubtotalCents =
    computedPreTaxSubtotalCents > 0 ? computedPreTaxSubtotalCents : preTaxSubtotalCents;

  
  const sharedPools = [
    { key: "taxShareCents", amount: taxCents },
    { key: "tipShareCents", amount: tipCents },
    { key: "miscShareCents", amount: miscTotalCents },
  ];

  
  const people = Object.keys(perPerson).length ? Object.keys(perPerson) : [ensurePerson("_unassigned")];
  const weights = people.map((person) => {
    const w = perPerson[person].preTaxSubtotalCents;
    return { person, weight: w };
  });

  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);

  
  if (totalWeight === 0) {
    const key = ensurePerson("_unassigned");
    perPerson[key].preTaxSubtotalCents = 0;
    
    perPerson[key].taxShareCents = taxCents;
    perPerson[key].tipShareCents = tipCents;
    perPerson[key].miscShareCents = miscTotalCents;
  } else {
    for (const pool of sharedPools) {
      
      let allocated = 0;
      const remainders = [];

      for (const { person, weight } of weights) {
        const raw = (pool.amount * weight) / totalWeight;
        const cents = Math.floor(raw); 
        const rem = raw - cents;
        perPerson[person][pool.key] += cents;
        allocated += cents;
        remainders.push({ person, rem });
      }

      
      let leftover = pool.amount - allocated;
      remainders
        .sort((a, b) => b.rem - a.rem)
        .slice(0, leftover)
        .forEach(({ person }) => {
          perPerson[person][pool.key] += 1;
        });
    }
  }

  
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


router.get("/getbyid", authenticate, async (req, res) => {
  try {
    const id = req.query.id || req.query.receiptId;
    if (!id) {
      return res.status(400).json({ error: "Missing required query param: id" });
    }

    const docRef = db.collection("receipts").doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Receipt not found" });
    }

    const result = snap.data() || {};

    
    const items = Array.isArray(result.items) ? result.items : [];
    const firstItem = items[0];
    const firstItemHasAssignee =
      !!firstItem &&
      (
        (Array.isArray(firstItem.people) && firstItem.people.length > 0) ||
        (Array.isArray(firstItem.assignees) && firstItem.assignees.length > 0) ||
        (Array.isArray(firstItem.assignedTo) && firstItem.assignedTo.length > 0) ||
        !!firstItem.person
      );

    let perperson = {};
    if (firstItemHasAssignee) {
      const calc = await Promise.resolve(calculate(result)); 

      
      perperson = (calc && calc.perPerson) ? calc.perPerson : calc || {};

      
      if (calc && calc.check) {
        result.check = calc.check;
      }

      
      result.perperson = perperson;
    } else {
      
      delete result.perperson;
      delete result.check;
    }

    return res.status(200).json({
      id: snap.id,
      result,     
      perperson,  
    });
  } catch (err) {
    console.error("GET /getbyid error:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
});

router.post('/deletebyid', authenticate, async(req, res) => {
  try{
    const {userid, receiptid} = req.body;
    if(!userid){
      return res.status(400).send({
        message: 'no user id was provided'
      })
    }

    const user = await db.collection('users').doc(userid).get();
    if(!user.exists){
      return res.status(404).send({
        message: 'user not found'
      })
    }
    const docSnap = await db.collection("receipts").doc(receiptid).get();
    if (!docSnap.exists) {
      return res.status(404).json({ message: "Receipt not found" });
    }
    const data = docSnap.data();

    if (data?.belongsto !== userid) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (data?.isDeleted === true) {
      return res.status(404).json({ message: "Receipt not found" });
    }

    const batch = db.batch();

    batch.set(db.collection('users').doc(userid), {
      receipts: admin.firestore.FieldValue.arrayRemove(receiptid),
      receiptCount: admin.firestore.FieldValue.increment(-1)
    }, 
    { merge: true })

    batch.set(db.collection('receipts').doc(receiptid), {
      isDeleted: true
    }, { merge: true })

    await batch.commit();

    return res.status(200).send({
      message: 'deleted!'
    })

  }catch(error){
    console.error(error);
    return res.status(500).send({
      message: 'something went wrong when deleting that receipt'
    })
  }
})

router.patch('/update-receipt', authenticate, async(req, res) => {
  try{
    const {userid, receiptid, items} = req.body;
    if(!userid || !receiptid || !items){
      return res.status(400).send({
        message: 'not complete request body'
      })
    }

    const receiptRef = db.collection('receipt').get();
  }catch(error){

  }
})

module.exports = router