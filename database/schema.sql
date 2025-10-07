-- Database schema for Core Extract batch processor
-- PostgreSQL 12+

-- Create database (run this manually if needed)
-- CREATE DATABASE batch_processor;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create organizations table (for multi-tenancy)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    domain VARCHAR(255), -- company.com for SSO
    plan VARCHAR(50) DEFAULT 'free',
    settings JSONB DEFAULT '{}',
    billing_email VARCHAR(255),
    stripe_customer_id VARCHAR(255),
    subscription_status VARCHAR(50) DEFAULT 'inactive',
    subscription_plan VARCHAR(50),
    subscription_current_period_end TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create users table (for authentication)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- Changed from 'user' to 'member'
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL, -- Multi-tenant support
    email_verified BOOLEAN DEFAULT FALSE,
    invited_by UUID REFERENCES users(id) ON DELETE SET NULL, -- Who invited this user
    invitation_token VARCHAR(255), -- Token for invitation
    invitation_expires_at TIMESTAMP WITH TIME ZONE, -- When invitation expires
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login_at TIMESTAMP WITH TIME ZONE,
    login_count INTEGER DEFAULT 0
);

-- Create user sessions table
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create user_organization_memberships table (many-to-many relationship)
CREATE TABLE IF NOT EXISTS user_organization_memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
    invitation_accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, organization_id)
);

-- Create indexes for user_organization_memberships
CREATE INDEX IF NOT EXISTS idx_user_org_memberships_user_id ON user_organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_user_org_memberships_organization_id ON user_organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_org_memberships_role ON user_organization_memberships(role);
CREATE INDEX IF NOT EXISTS idx_user_org_memberships_joined_at ON user_organization_memberships(joined_at);

-- Add updated_at trigger for user_organization_memberships
CREATE TRIGGER update_user_organization_memberships_updated_at BEFORE UPDATE ON user_organization_memberships
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create audit log table
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL, -- Track organization context
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id VARCHAR(255),
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create jobs table
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    schema_data JSONB NOT NULL,
    summary JSONB,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE, -- Multi-tenant support
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create job_files table
CREATE TABLE IF NOT EXISTS job_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    size BIGINT NOT NULL,
    s3_key VARCHAR(500),
    file_hash VARCHAR(64),
    extraction_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    processing_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    extracted_text TEXT,
    extracted_tables JSONB,
    pages JSONB, -- Page-by-page content from Document AI
    markdown TEXT, -- Markdown formatted content from Document AI + V3 converter
    result JSONB,
    processing_metadata JSONB,
    extraction_error TEXT,
    processing_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for authentication tables
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);

CREATE INDEX IF NOT EXISTS idx_job_files_job_id ON job_files(job_id);
CREATE INDEX IF NOT EXISTS idx_job_files_extraction_status ON job_files(extraction_status);
CREATE INDEX IF NOT EXISTS idx_job_files_processing_status ON job_files(processing_status);
CREATE INDEX IF NOT EXISTS idx_job_files_created_at ON job_files(created_at);

-- Create JSONB indexes for schema searches
CREATE INDEX IF NOT EXISTS idx_jobs_schema_data ON jobs USING GIN (schema_data);
CREATE INDEX IF NOT EXISTS idx_job_files_extracted_tables ON job_files USING GIN (extracted_tables);
CREATE INDEX IF NOT EXISTS idx_job_files_result ON job_files USING GIN (result);

-- Create organization-related indexes
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_domain ON organizations(domain);
CREATE INDEX IF NOT EXISTS idx_organizations_plan ON organizations(plan);
CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_jobs_organization_id ON jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_organization_id ON organization_invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(email);
CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON organization_invitations(token);
CREATE INDEX IF NOT EXISTS idx_org_invitations_expires_at ON organization_invitations(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_organization_id ON audit_logs(organization_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers to automatically update updated_at
CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_job_files_updated_at BEFORE UPDATE ON job_files
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default admin user (for single-user mode)
-- Password: 'admin123' (change in production!)
INSERT INTO users (id, email, password_hash, name, role, email_verified) 
VALUES (
    '00000000-0000-0000-0000-000000000000', 
    'admin@coreextract.com', 
    '$2b$12$0DzNdPoJJMMhFNXhYgvJ7.fumPENbtWVNz.IikBXFDd5wF.qF31XW', -- 'admin123'
    'System Admin',
    'admin',
    true
)
ON CONFLICT (id) DO NOTHING;

-- Create view for job statistics
CREATE OR REPLACE VIEW job_statistics AS
SELECT 
    j.id,
    j.name,
    j.status,
    j.created_at,
    j.updated_at,
    COUNT(jf.id) as total_files,
    COUNT(CASE WHEN jf.extraction_status = 'completed' THEN 1 END) as extraction_completed,
    COUNT(CASE WHEN jf.extraction_status = 'failed' THEN 1 END) as extraction_failed,
    COUNT(CASE WHEN jf.processing_status = 'completed' THEN 1 END) as processing_completed,
    COUNT(CASE WHEN jf.processing_status = 'failed' THEN 1 END) as processing_failed,
    SUM(jf.size) as total_size_bytes
FROM jobs j
LEFT JOIN job_files jf ON j.id = jf.job_id
GROUP BY j.id, j.name, j.status, j.created_at, j.updated_at;

-- Create view for system statistics
CREATE OR REPLACE VIEW system_statistics AS
SELECT 
    COUNT(*) as total_jobs,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs,
    COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_jobs,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_jobs,
    COUNT(CASE WHEN status = 'queued' THEN 1 END) as queued_jobs,
    (SELECT COUNT(*) FROM job_files) as total_files,
    (SELECT COUNT(*) FROM job_files WHERE extraction_status = 'completed') as files_extracted,
    (SELECT COUNT(*) FROM job_files WHERE processing_status = 'completed') as files_processed,
    (SELECT SUM(size) FROM job_files) as total_storage_bytes
FROM jobs;

-- Create view for organization statistics
CREATE OR REPLACE VIEW organization_statistics AS
SELECT 
    o.id,
    o.name,
    o.slug,
    o.plan,
    o.created_at,
    o.updated_at,
    COUNT(DISTINCT u.id) AS total_members,
    COUNT(DISTINCT j.id) AS total_jobs,
    COUNT(DISTINCT jf.id) AS total_files,
    COUNT(CASE WHEN u.role = 'owner' THEN 1 END) AS owners_count,
    COUNT(CASE WHEN u.role = 'admin' THEN 1 END) AS admins_count,
    COUNT(CASE WHEN u.role = 'member' THEN 1 END) AS members_count,
    COUNT(CASE WHEN u.role = 'viewer' THEN 1 END) AS viewers_count
FROM organizations o
LEFT JOIN users u ON o.id = u.organization_id
LEFT JOIN jobs j ON o.id = j.organization_id
LEFT JOIN job_files jf ON j.id = jf.job_id
GROUP BY o.id, o.name, o.slug, o.plan, o.created_at, o.updated_at
ORDER BY o.created_at DESC;
