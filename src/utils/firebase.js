import admin from 'firebase-admin'
import dotenv from 'dotenv';
//import serviceAccount from '../../ADMIN_CERT.json' assert { type: 'json' };

dotenv.config();
/*admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.BUCKET
  });*/

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.BUCKET
  });

export const db = admin.firestore();
export const storage = admin.storage().bucket();
