import admin from 'firebase-admin'
import serviceAccount from '../../ADMIN_CERT.json' assert {type: 'json'}
import dotenv from 'dotenv';

dotenv.config();

admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.BUCKET
  });

export const db = admin.firestore();
export const storage = admin.storage().bucket();
