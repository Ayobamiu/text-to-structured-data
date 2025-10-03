import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initializeDatabase() {
    const client = new Client({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'batch_processor',
        password: process.env.DB_PASSWORD || 'password',
        port: process.env.DB_PORT || 5432,
    });

    try {
        console.log('🔌 Connecting to database...');
        await client.connect();
        console.log('✅ Connected to database');

        // Read and execute schema
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        console.log('📋 Executing database schema...');
        await client.query(schema);
        console.log('✅ Database schema created successfully');

        // Test the setup
        console.log('🧪 Testing database setup...');
        const result = await client.query('SELECT * FROM system_statistics');
        console.log('✅ Database setup complete');
        console.log('📊 System statistics:', result.rows[0]);

    } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        throw error;
    } finally {
        await client.end();
        console.log('🔌 Database connection closed');
    }
}

// Run initialization if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    initializeDatabase()
        .then(() => {
            console.log('🎉 Database initialization completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Database initialization failed:', error);
            process.exit(1);
        });
}

export default initializeDatabase;
