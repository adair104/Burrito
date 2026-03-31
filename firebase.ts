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

  if (process.env.SERVICE_ACCOUNT_JSON) {
    // JSON string env var (for Railway / cloud deployments)
    const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: appletConfig.projectId,
    });
    console.log('✅ Firebase Admin initialized via SERVICE_ACCOUNT_JSON env var');
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

// ── Guild config cache ────────────────────────────────────────────────────────
// Caches configs in memory for 30 seconds to avoid a Firestore round-trip on
// every button press / command. Invalidated immediately on write.
const CONFIG_TTL_MS = 30_000;
const guildConfigCache = new Map<string, { data: any; expiresAt: number }>();

export async function getGuildConfig(guildId: string) {
  const cached = guildConfigCache.get(guildId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const docSnap = await db.collection('guilds').doc(guildId).collection('config').doc('bot').get();
    const data = docSnap.exists ? docSnap.data() : null;
    guildConfigCache.set(guildId, { data, expiresAt: Date.now() + CONFIG_TTL_MS });
    return data;
  } catch (error) {
    console.error(`Error getting guild config for ${guildId}:`, error);
    return null;
  }
}

export async function updateGuildConfig(guildId: string, data: any) {
  try {
    await db.collection('guilds').doc(guildId).collection('config').doc('bot').set(data, { merge: true });
    // Immediately update cache so next read is consistent without a round-trip
    guildConfigCache.set(guildId, { data, expiresAt: Date.now() + CONFIG_TTL_MS });
    return true;
  } catch (error) {
    console.error(`Error updating guild config for ${guildId}:`, error);
    return false;
  }
}
