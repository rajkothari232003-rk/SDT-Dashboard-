// Firebase Admin bootstrap for functions. Set env var
// FIREBASE_SERVICE_ACCOUNT to the full service-account JSON.
const admin = require('firebase-admin');
let db = null;
function getDb(){
  if (db) return db;
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  db = admin.firestore();
  return db;
}
module.exports = { getDb, admin };
