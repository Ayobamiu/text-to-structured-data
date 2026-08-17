/**
 * Dedicated org + user for public demo jobs so they never land in a
 * customer organization. Cached after first resolve.
 */

import crypto from 'crypto';
import pool from '../db/pool.js';
import { hashPassword } from '../auth.js';
import logger from '../utils/logger.js';

const DEMO_ORG_SLUG = 'core-extract-demo';
const DEMO_USER_EMAIL = 'demo-pipeline@coreextract.app';

let cached = null;

export async function resolveDemoIdentity() {
    if (process.env.DEMO_ORGANIZATION_ID && process.env.DEMO_USER_ID) {
        return {
            organizationId: process.env.DEMO_ORGANIZATION_ID,
            userId: process.env.DEMO_USER_ID,
        };
    }
    if (cached) return cached;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let org = (await client.query(
            `SELECT id FROM organizations WHERE slug = $1`,
            [DEMO_ORG_SLUG]
        )).rows[0];

        if (!org) {
            org = (await client.query(
                `INSERT INTO organizations (name, slug, plan)
                 VALUES ('Core Extract Demo', $1, 'free')
                 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [DEMO_ORG_SLUG]
            )).rows[0];
            logger.info({ orgId: org.id }, 'Created demo organization');
        }

        let user = (await client.query(
            `SELECT id FROM users WHERE email = $1`,
            [DEMO_USER_EMAIL]
        )).rows[0];

        if (!user) {
            const passwordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
            user = (await client.query(
                `INSERT INTO users (email, password_hash, name, role, email_verified)
                 VALUES ($1, $2, 'Demo Pipeline', 'user', true)
                 ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [DEMO_USER_EMAIL, passwordHash]
            )).rows[0];
            logger.info({ userId: user.id }, 'Created demo pipeline user');
        }

        await client.query(
            `INSERT INTO user_organization_memberships (user_id, organization_id, role, joined_at)
             VALUES ($1, $2, 'owner', NOW())
             ON CONFLICT (user_id, organization_id) DO NOTHING`,
            [user.id, org.id]
        );

        await client.query('COMMIT');
        cached = { organizationId: org.id, userId: user.id };
        return cached;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
