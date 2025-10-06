import { adminDb, adminAuth } from './admin.js';
import admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';

// --- User Management ---

export async function createUser(userData) {
    try {
        // Check if user with this email already exists
        const existingUser = await getUserByEmail(userData.email);
        if (existingUser) {
            throw new Error(`User with email ${userData.email} already exists`);
        }

        const userId = uuidv4();
        const userDoc = {
            id: userId,
            email: userData.email,
            name: userData.name,
            role: userData.role || 'member',
            passwordHash: userData.passwordHash, // Store the hashed password
            emailVerified: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastLoginAt: null,
            loginCount: 0
        };

        await adminDb.collection('users').doc(userId).set(userDoc);

        return {
            id: userId,
            email: userDoc.email,
            name: userDoc.name,
            role: userDoc.role,
            email_verified: userDoc.emailVerified,
            created_at: userDoc.createdAt
        };
    } catch (error) {
        console.error('Error creating user:', error);
        throw error;
    }
}

export async function getUserById(userId) {
    try {
        const userDoc = await adminDb.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return null;
        }

        const userData = userDoc.data();
        return {
            id: userData.id,
            email: userData.email,
            name: userData.name,
            role: userData.role,
            email_verified: userData.emailVerified,
            created_at: userData.createdAt,
            last_login_at: userData.lastLoginAt,
            login_count: userData.loginCount
        };
    } catch (error) {
        console.error('Error getting user:', error);
        throw error;
    }
}

export async function getUserByEmail(email) {
    try {
        const usersSnapshot = await adminDb.collection('users')
            .where('email', '==', email)
            .limit(1)
            .get();

        if (usersSnapshot.empty) {
            return null;
        }

        const userDoc = usersSnapshot.docs[0];
        const userData = userDoc.data();

        return {
            id: userData.id,
            email: userData.email,
            name: userData.name,
            role: userData.role,
            passwordHash: userData.passwordHash, // Include password hash for authentication
            email_verified: userData.emailVerified,
            created_at: userData.createdAt,
            last_login_at: userData.lastLoginAt,
            login_count: userData.loginCount
        };
    } catch (error) {
        console.error('Error getting user by email:', error);
        throw error;
    }
}

export async function updateUser(userId, updateData) {
    try {
        const updateDoc = {
            ...updateData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await adminDb.collection('users').doc(userId).update(updateDoc);
        return true;
    } catch (error) {
        console.error('Error updating user:', error);
        throw error;
    }
}

// --- Organization Management ---

export async function createOrganization(orgData) {
    try {
        const orgId = uuidv4();
        const orgDoc = {
            id: orgId,
            name: orgData.name,
            slug: orgData.slug,
            domain: orgData.domain || null,
            plan: orgData.plan || 'free',
            settings: orgData.settings || {},
            billingEmail: orgData.billingEmail || null,
            stripeCustomerId: orgData.stripeCustomerId || null,
            subscriptionStatus: orgData.subscriptionStatus || 'inactive',
            subscriptionPlan: orgData.subscriptionPlan || null,
            subscriptionCurrentPeriodEnd: orgData.subscriptionCurrentPeriodEnd || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await adminDb.collection('organizations').doc(orgId).set(orgDoc);
        return orgDoc;
    } catch (error) {
        console.error('Error creating organization:', error);
        throw error;
    }
}

export async function createUserOrganizationMembership(userId, organizationId, role = 'member', invitedBy = null) {
    try {
        const membershipId = uuidv4();
        const membershipDoc = {
            id: membershipId,
            userId: userId,
            organizationId: organizationId,
            role: role,
            joinedAt: admin.firestore.FieldValue.serverTimestamp(),
            invitedBy: invitedBy || null,
            invitationAcceptedAt: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await adminDb.collection('userOrganizationMemberships').doc(membershipId).set(membershipDoc);
        return membershipDoc;
    } catch (error) {
        console.error('Error creating user organization membership:', error);
        throw error;
    }
}

export async function getUserOrganizations(userId) {
    try {
        const membershipsSnapshot = await adminDb.collection('userOrganizationMemberships')
            .where('userId', '==', userId)
            .get();

        const organizations = [];

        for (const membershipDoc of membershipsSnapshot.docs) {
            const membership = membershipDoc.data();
            const orgDoc = await adminDb.collection('organizations').doc(membership.organizationId).get();

            if (orgDoc.exists) {
                const orgData = orgDoc.data();
                organizations.push({
                    id: orgData.id,
                    name: orgData.name,
                    slug: orgData.slug,
                    plan: orgData.plan,
                    role: membership.role,
                    joinedAt: membership.joinedAt
                });
            }
        }

        return organizations;
    } catch (error) {
        console.error('Error getting user organizations:', error);
        throw error;
    }
}

export async function createDefaultOrganizationForUser(userId, userName, userEmail) {
    try {
        const orgName = `${userName}'s Organization`;
        const orgSlug = `${userName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-org-${Date.now()}`;

        // Create organization
        const organization = await createOrganization({
            name: orgName,
            slug: orgSlug,
            plan: 'free'
        });

        // Add user as owner
        const membership = await createUserOrganizationMembership(userId, organization.id, 'owner');

        return {
            organization,
            membership
        };
    } catch (error) {
        console.error('Error creating default organization for user:', error);
        throw error;
    }
}

// --- Job Management ---

export async function createJob(jobData) {
    try {
        const jobId = uuidv4();
        const jobDoc = {
            id: jobId,
            name: jobData.name,
            status: jobData.status || 'queued',
            schemaData: jobData.schemaData,
            summary: jobData.summary || null,
            userId: jobData.userId,
            organizationId: jobData.organizationId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await adminDb.collection('jobs').doc(jobId).set(jobDoc);
        return jobDoc;
    } catch (error) {
        console.error('Error creating job:', error);
        throw error;
    }
}

export async function getJobById(jobId) {
    try {
        const jobDoc = await adminDb.collection('jobs').doc(jobId).get();
        if (!jobDoc.exists) {
            return null;
        }

        return jobDoc.data();
    } catch (error) {
        console.error('Error getting job:', error);
        throw error;
    }
}

export async function listJobsByOrganizations(organizationIds) {
    try {
        const jobsSnapshot = await adminDb.collection('jobs')
            .where('organizationId', 'in', organizationIds)
            .orderBy('createdAt', 'desc')
            .get();

        const jobs = [];

        for (const jobDoc of jobsSnapshot.docs) {
            const jobData = jobDoc.data();

            // Get file count for each job
            const filesSnapshot = await adminDb.collection('jobFiles')
                .where('jobId', '==', jobData.id)
                .get();

            jobs.push({
                ...jobData,
                file_count: filesSnapshot.size
            });
        }

        return jobs;
    } catch (error) {
        console.error('Error listing jobs by organizations:', error);
        throw error;
    }
}

// --- Job Files Management ---

export async function addFileToJob(jobId, fileData) {
    try {
        const fileId = uuidv4();
        const fileDoc = {
            id: fileId,
            jobId: jobId,
            extractionStatus: 'pending',
            processingStatus: 'pending',
            extractedText: null,
            extractedTables: null,
            markdown: null,
            result: null,
            processingMetadata: null,
            extractionError: null,
            processingError: null,
            createdAt: fileData.createdAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedAt: null,
            ...fileData
        };

        await adminDb.collection('jobFiles').doc(fileId).set(fileDoc);
        return fileDoc;
    } catch (error) {
        console.error('Error adding file to job:', error);
        throw error;
    }
}

export async function updateFileExtractionStatus(fileId, status, data = {}) {
    try {
        const updateData = {
            extractionStatus: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            ...data
        };

        // Handle large text fields by truncating if necessary
        if (updateData.extractedText && updateData.extractedText.length > 1000000) { // 1MB limit
            console.warn(`Extracted text too large (${updateData.extractedText.length} chars), truncating...`);
            updateData.extractedText = updateData.extractedText.substring(0, 1000000) + '...[truncated]';
        }

        // Handle large markdown fields
        if (updateData.markdown && updateData.markdown.length > 1000000) { // 1MB limit
            console.warn(`Markdown too large (${updateData.markdown.length} chars), truncating...`);
            updateData.markdown = updateData.markdown.substring(0, 1000000) + '...[truncated]';
        }

        // Ensure extractedTables is a string if it exists
        if (updateData.extractedTables && typeof updateData.extractedTables !== 'string') {
            updateData.extractedTables = JSON.stringify(updateData.extractedTables);
        }

        await adminDb.collection('jobFiles').doc(fileId).update(updateData);
        console.log(`✅ File extraction status updated: ${fileId} -> ${status}`);
        return true;
    } catch (error) {
        console.error('Error updating file extraction status:', error);
        throw error;
    }
}

export async function updateFileProcessingStatus(fileId, status, data = {}) {
    try {
        const updateData = {
            processingStatus: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            ...data
        };

        await adminDb.collection('jobFiles').doc(fileId).update(updateData);
        return true;
    } catch (error) {
        console.error('Error updating file processing status:', error);
        throw error;
    }
}

export async function getJobFiles(jobId) {
    try {
        const filesSnapshot = await adminDb.collection('jobFiles')
            .where('jobId', '==', jobId)
            .orderBy('createdAt', 'asc')
            .get();

        return filesSnapshot.docs.map(doc => doc.data());
    } catch (error) {
        console.error('Error getting job files:', error);
        throw error;
    }
}

export async function getFileResult(fileId) {
    try {
        const fileDoc = await adminDb.collection('jobFiles').doc(fileId).get();
        if (!fileDoc.exists) {
            return null;
        }

        return fileDoc.data();
    } catch (error) {
        console.error('Error getting file result:', error);
        throw error;
    }
}

export async function updateJobStatus(jobId, status) {
    try {
        await adminDb.collection('jobs').doc(jobId).update({
            status: status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ Job ${jobId} status updated to: ${status}`);
        return true;
    } catch (error) {
        console.error('Error updating job status:', error);
        throw error;
    }
}
