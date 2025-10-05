#!/bin/bash

# Infrastructure Setup Script for AI Extractor Backend
# This script helps you set up PostgreSQL and Redis infrastructure

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

echo -e "${BLUE}🏗️  AI Extractor Backend - Infrastructure Setup${NC}"

# Check if Docker is running
check_docker() {
    print_info "Checking Docker status..."
    if ! docker info > /dev/null 2>&1; then
        print_error "Docker is not running. Please start Docker Desktop."
        exit 1
    fi
    print_status "Docker is running"
}

# Start local infrastructure
start_local_infrastructure() {
    print_info "Starting local PostgreSQL and Redis..."
    
    # Start services
    docker-compose up -d postgres redis
    
    # Wait for services to be ready
    print_info "Waiting for services to be ready..."
    sleep 10
    
    # Check PostgreSQL
    if docker exec core-extract-postgres pg_isready -U postgres > /dev/null 2>&1; then
        print_status "PostgreSQL is ready"
    else
        print_error "PostgreSQL failed to start"
        exit 1
    fi
    
    # Check Redis
    if docker exec core-extract-redis redis-cli ping > /dev/null 2>&1; then
        print_status "Redis is ready"
    else
        print_error "Redis failed to start"
        exit 1
    fi
}

# Create environment file
create_env_file() {
    print_info "Creating environment configuration..."
    
    if [ -f ".env" ]; then
        print_warning ".env file already exists. Backing up to .env.backup"
        cp .env .env.backup
    fi
    
    cat > .env << 'EOF'
# Production Environment Configuration
NODE_ENV=production

# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=batch_processor
DB_USER=postgres
DB_PASSWORD=password
DB_SSL=false
DB_POOL_MIN=2
DB_POOL_MAX=20
DB_POOL_IDLE_TIMEOUT=30000

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_TLS=false
REDIS_RETRY_DELAY=1000
REDIS_MAX_RETRIES=3

# Flask Service Configuration
FLASK_URL=http://localhost:5001
FLASK_TIMEOUT=30000
FLASK_RETRY_ATTEMPTS=3

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o-mini
OPENAI_MAX_TOKENS=4000
OPENAI_TEMPERATURE=0.1

# AWS S3 Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_access_key_here
AWS_SECRET_ACCESS_KEY=your_aws_secret_key_here
S3_BUCKET_NAME=document-extractor-files
S3_SIGNED_URL_EXPIRY=3600
CLOUD_STORAGE_ENABLED=true

# Authentication Configuration
JWT_SECRET=your-super-secret-jwt-key-change-in-production-make-it-long-and-random
JWT_EXPIRES_IN=24h
REFRESH_TOKEN_EXPIRES_IN=7d
API_KEY=your-api-key-for-programmatic-access

# Security Configuration
CORS_ORIGIN=http://localhost:3002
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
HELMET_ENABLED=true

# File Storage Configuration
FILE_RETENTION_DAYS=30
MAX_FILE_SIZE=50MB
ALLOWED_FILE_TYPES=pdf,doc,docx,txt

# Server Configuration
PORT=3000
HOST=0.0.0.0
WORKER_PROCESSES=1
WORKER_TIMEOUT=300000

# Logging Configuration
LOG_LEVEL=info
LOG_FORMAT=json
LOG_FILE_ENABLED=true
LOG_FILE_PATH=/var/log/app.log

# Monitoring Configuration
HEALTH_CHECK_INTERVAL=30000
METRICS_ENABLED=true
METRICS_PORT=9090

# Queue Configuration
QUEUE_CONCURRENCY=1
QUEUE_RETRY_DELAY=5000
QUEUE_MAX_RETRIES=3
QUEUE_CLEANUP_INTERVAL=3600000
EOF
    
    print_status "Environment file created"
}

# Test database connection
test_database_connection() {
    print_info "Testing database connection..."
    
    # Test PostgreSQL
    if docker exec core-extract-postgres psql -U postgres -d batch_processor -c "SELECT 1;" > /dev/null 2>&1; then
        print_status "PostgreSQL connection successful"
    else
        print_error "PostgreSQL connection failed"
        exit 1
    fi
    
    # Test Redis
    if docker exec core-extract-redis redis-cli ping | grep -q "PONG"; then
        print_status "Redis connection successful"
    else
        print_error "Redis connection failed"
        exit 1
    fi
}

# Show connection details
show_connection_details() {
    print_info "Infrastructure Connection Details:"
    echo ""
    echo "📊 PostgreSQL:"
    echo "   Host: localhost"
    echo "   Port: 5432"
    echo "   Database: batch_processor"
    echo "   Username: postgres"
    echo "   Password: password"
    echo ""
    echo "🔴 Redis:"
    echo "   Host: localhost"
    echo "   Port: 6379"
    echo "   Password: (none)"
    echo ""
    echo "🔗 Connection URLs:"
    echo "   PostgreSQL: postgresql://postgres:password@localhost:5432/batch_processor"
    echo "   Redis: redis://localhost:6379"
    echo ""
}

# Main setup function
main() {
    check_docker
    start_local_infrastructure
    create_env_file
    test_database_connection
    show_connection_details
    
    print_status "Infrastructure setup completed!"
    print_info "Next steps:"
    echo "1. Update .env file with your actual API keys"
    echo "2. Run: npm install"
    echo "3. Run: npm start"
    echo "4. Test: curl http://localhost:3000/health"
}

# Handle script arguments
case "${1:-}" in
    "start")
        check_docker
        start_local_infrastructure
        ;;
    "stop")
        print_info "Stopping infrastructure..."
        docker-compose down
        print_status "Infrastructure stopped"
        ;;
    "restart")
        print_info "Restarting infrastructure..."
        docker-compose down
        docker-compose up -d postgres redis
        print_status "Infrastructure restarted"
        ;;
    "status")
        print_info "Infrastructure status:"
        docker-compose ps
        ;;
    "test")
        test_database_connection
        ;;
    *)
        main
        ;;
esac
