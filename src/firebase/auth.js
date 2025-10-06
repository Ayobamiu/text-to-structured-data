import { adminDb } from './admin.js';
import admin from 'firebase-admin';
import { hashPassword, comparePassword } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import {
    createUser as createFirebaseUser,
    getUserByEmail,
    getUserById,
    updateUser,
    createDefaultOrganizationForUser
} from './database.js';

// --- Firebase Authentication Functions ---

export async function authenticateUser(email, password) {
    try {
        // Get user from Firestore
        const user = await getUserByEmail(email);
        if (!user) {
            throw new Error(`No account found with email: ${email}. Please check your email address or create a new account.`);
        }

        // For now, we'll use our existing password hashing
        // In a full Firebase migration, you'd use Firebase Auth
        const isValidPassword = await comparePassword(password, user.passwordHash);
        if (!isValidPassword) {
            throw new Error(`Incorrect password for ${email}. Please check your password and try again.`);
        }

        // Update login info
        await updateUser(user.id, {
            lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
            loginCount: (user.login_count || 0) + 1
        });

        return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            email_verified: user.email_verified,
            last_login_at: new Date(),
            login_count: (user.login_count || 0) + 1
        };
    } catch (error) {
        console.error('Authentication error:', error.message);
        throw error;
    }
}

export async function createUserWithFirebase(userData) {
    try {
        // Create user in Firestore
        const user = await createFirebaseUser({
            email: userData.email,
            name: userData.name,
            role: userData.role || 'member',
            passwordHash: await hashPassword(userData.password)
        });

        // Create default organization
        console.log(`🏢 Creating default organization for user: ${user.name} (ID: ${user.id})`);
        try {
            const { organization } = await createDefaultOrganizationForUser(user.id, user.name, user.email);
            console.log(`✅ Created default organization: ${organization.name} (${organization.slug})`);
        } catch (orgError) {
            console.error('❌ Failed to create default organization:', orgError.message);
            console.log('⚠️ Continuing with user registration without organization...');
        }

        return user;
    } catch (error) {
        console.error('Error creating user with Firebase:', error);
        throw error;
    }
}

export async function verifyFirebaseToken(token) {
    try {
        const decodedToken = await adminAuth.verifyIdToken(token);
        return decodedToken;
    } catch (error) {
        console.error('Error verifying Firebase token:', error);
        throw error;
    }
}

export async function createFirebaseSession(userId, token, sessionData = {}) {
    try {
        // In Firebase, sessions are handled by Firebase Auth
        // We can store additional session data in Firestore if needed
        const sessionId = uuidv4();
        const sessionDoc = {
            id: sessionId,
            userId: userId,
            token: token, // Use the token directly
            ipAddress: sessionData.ipAddress,
            userAgent: sessionData.userAgent,
            expiresAt: sessionData.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days default
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await adminDb.collection('userSessions').doc(sessionId).set(sessionDoc);
        return sessionDoc;
    } catch (error) {
        console.error('Error creating Firebase session:', error);
        throw error;
    }
}

export async function validateFirebaseSession(token) {
    try {
        const sessionsSnapshot = await adminDb.collection('userSessions')
            .where('token', '==', token)
            .where('expiresAt', '>', admin.firestore.FieldValue.serverTimestamp())
            .limit(1)
            .get();

        if (sessionsSnapshot.empty) {
            return null;
        }

        const sessionDoc = sessionsSnapshot.docs[0];
        return sessionDoc.data();
    } catch (error) {
        console.error('Error validating Firebase session:', error);
        throw error;
    }
}

export async function deleteFirebaseSession(token) {
    try {
        const sessionsSnapshot = await adminDb.collection('userSessions')
            .where('token', '==', token)
            .get();

        const batch = adminDb.batch();
        sessionsSnapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        return true;
    } catch (error) {
        console.error('Error deleting Firebase session:', error);
        throw error;
    }
}

// Re-export database functions for auth routes
// export { getUserById, updateUser };

export async function deleteAllFirebaseSessions(userId) {
    try {
        const sessionsSnapshot = await adminDb.collection('userSessions')
            .where('userId', '==', userId)
            .get();

        const batch = adminDb.batch();
        sessionsSnapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        return sessionsSnapshot.size;
    } catch (error) {
        console.error('Error deleting all Firebase sessions:', error);
        throw error;
    }
}
