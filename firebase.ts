import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔥 Initializing Firebase Admin SDK...');

// Load the applet config for projectId and databaseId
let appletConfig: any = {};
const configPath = join(__dirname, 'firebase-applet-config.json');

try {
  if (existsSync(configPath)) {
    appletConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    console.log('✅ Firebase applet config loaded.');
  } else {
    console.warn('⚠️ firebase-applet-config.json not found at', configPath);
  }
} catch (err) {
  console.error('❌ Error parsing firebase-applet-config.json:', err);
}

// Initialize Firebase Admin
// Priority: GOOGLE_APPLICATION_CREDENTIALS env var > service-account.json file > Application Default Credentials
let app: admin.app.App;

try {
  const serviceAccountPath = join(__dirname, 'service-account.json');

  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    // Individual env vars — most reliable for Railway (no JSON truncation issues)
    const serviceAccount = {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID || appletConfig.projectId,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
    };
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || appletConfig.projectId,
    });
    console.log('✅ Firebase Admin initialized via individual FIREBASE_* env vars');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Explicit path via env var (recommended for production)
    app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: appletConfig.projectId,
    });
    console.log('✅ Firebase Admin initialized via GOOGLE_APPLICATION_CREDENTIALS');
  } else if (existsSync(serviceAccountPath)) {
    // Local service-account.json file
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: appletConfig.projectId,
    });
    console.log('✅ Firebase Admin initialized via service-account.json');
  } else {
    // Fall back to Application Default Credentials (works on GCP/Cloud Run)
    app = admin.initializeApp({
      projectId: appletConfig.projectId,
    });
    console.log('✅ Firebase Admin initialized via Application Default Credentials');
  }
} catch (err) {
  console.error('❌ Firebase Admin initialization failed:', err);
  process.exit(1);
}

// Initialize Firestore with the specific database ID from applet config
const databaseId = appletConfig.firestoreDatabaseId || '(default)';
console.log('🔍 Initializing Firestore with databaseId:', databaseId);

// For named databases (non-default), pass the databaseId directly.
// firebase-admin v12+ supports: getFirestore(app, databaseId)
export const db = getFirestore(app, databaseId);

console.log('✅ Firestore Admin DB initialized.');

// Re-export FieldValue.serverTimestamp for compatibility
export const serverTimestamp = admin.firestore.FieldValue.serverTimestamp;

export async function getBotConfig() {
  try {
    const docSnap = await db.collection('config').doc('bot').get();
    return docSnap.exists ? docSnap.data() : null;
  } catch (error) {
    console.error('Error getting bot config:', error);
    return null;
  }
}

export async function updateBotConfig(data: any) {
  try {
    await db.collection('config').doc('bot').set(data, { merge: true });
    return true;
  } catch (error) {
    console.error('Error updating bot config:', error);
    return false;
  }
}

export async function getGuildConfig(guildId: string) {
  try {
    const docSnap = await db.collection('guilds').doc(guildId).collection('config').doc('bot').get();
    return docSnap.exists ? docSnap.data() : null;
  } catch (error) {
    console.error(`Error getting guild config for ${guildId}:`, error);
    return null;
  }
}

export async function updateGuildConfig(guildId: string, data: any) {
  try {
    await db.collection('guilds').doc(guildId).collection('config').doc('bot').set(data, { merge: true });
    return true;
  } catch (error) {
    console.error(`Error updating guild config for ${guildId}:`, error);
    return false;
  }
}
