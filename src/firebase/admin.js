import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
    try {
        // Try to use service account key first
        if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
            try {
                // Handle multi-line JSON in .env file
                const jsonString = process.env.FIREBASE_SERVICE_ACCOUNT_KEY.replace(/\n/g, '').replace(/\s+/g, ' ');
                const serviceAccount = JSON.parse(jsonString);

                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                    projectId: process.env.FIREBASE_PROJECT_ID?.replace(/[",]/g, '').trim(),
                    storageBucket: process.env.FIREBASE_STORAGE_BUCKET?.replace(/[",]/g, '').trim()
                });
                console.log('✅ Firebase initialized with service account');
            } catch (parseError) {
                console.error('❌ Error parsing service account key:', parseError.message);
                throw parseError;
            }
        } else {
            // Use default credentials (Application Default Credentials)
            admin.initializeApp({
                projectId: process.env.FIREBASE_PROJECT_ID?.replace(/[",]/g, '').trim(),
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET?.replace(/[",]/g, '').trim()
            });
            console.log('✅ Firebase initialized with default credentials');
        }
    } catch (error) {
        console.error('❌ Firebase initialization failed:', error.message);
        console.log('⚠️ Falling back to basic initialization...');
        admin.initializeApp();
    }
}

export const adminAuth = admin.auth();
export const adminDb = admin.firestore();
export const adminStorage = admin.storage();

export default admin;
