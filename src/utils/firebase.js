import admin from 'firebase-admin'
import dotenv from 'dotenv';
import serviceAccount from '../../ADMIN_CERT.json' assert { type: 'json' };

dotenv.config();

export const ad = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.BUCKET
  });

export const db = admin.firestore();
export const storage = admin.storage().bucket();
