#!/bin/bash

# AI Extractor Backend - Production Deployment Script
# This script handles the complete deployment process for production

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="ai-extractor-backend"
DOCKER_IMAGE="ai-extractor-backend"
REGISTRY="ghcr.io"
NAMESPACE="your-org"

echo -e "${BLUE}🚀 Starting AI Extractor Backend Production Deployment${NC}"

# Function to print colored output
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

# Check if required tools are installed
check_dependencies() {
    print_info "Checking dependencies..."
    
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        print_error "Docker Compose is not installed"
        exit 1
    fi
    
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        exit 1
    fi
    
    print_status "All dependencies are available"
}

# Validate environment file
validate_environment() {
    print_info "Validating environment configuration..."
    
    if [ ! -f ".env" ]; then
        print_error "Environment file .env not found"
        print_info "Please copy env.example to .env and configure it"
        exit 1
    fi
    
    # Check required environment variables
    required_vars=(
        "DB_HOST" "DB_NAME" "DB_USER" "DB_PASSWORD"
        "REDIS_HOST" "FLASK_URL" "OPENAI_API_KEY"
        "AWS_REGION" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY"
        "S3_BUCKET_NAME" "JWT_SECRET" "API_KEY"
    )
    
    for var in "${required_vars[@]}"; do
        if ! grep -q "^${var}=" .env || grep -q "^${var}=$" .env; then
            print_error "Required environment variable ${var} is not set"
            exit 1
        fi
    done
    
    print_status "Environment configuration is valid"
}

# Run tests
run_tests() {
    print_info "Running tests..."
    
    if [ -f "package.json" ] && grep -q '"test"' package.json; then
        npm test
        print_status "Tests passed"
    else
        print_warning "No tests configured, skipping"
    fi
}

# Build Docker image
build_docker_image() {
    print_info "Building Docker image..."
    
    docker build -t ${DOCKER_IMAGE}:latest .
    docker tag ${DOCKER_IMAGE}:latest ${REGISTRY}/${NAMESPACE}/${DOCKER_IMAGE}:latest
    
    print_status "Docker image built successfully"
}

# Push Docker image to registry
push_docker_image() {
    print_info "Pushing Docker image to registry..."
    
    docker push ${REGISTRY}/${NAMESPACE}/${DOCKER_IMAGE}:latest
    
    print_status "Docker image pushed successfully"
}

# Deploy with Docker Compose
deploy_with_compose() {
    print_info "Deploying with Docker Compose..."
    
    # Stop existing containers
    docker-compose -f docker-compose.production.yml down
    
    # Start services
    docker-compose -f docker-compose.production.yml up -d
    
    # Wait for services to be healthy
    print_info "Waiting for services to be healthy..."
    sleep 30
    
    # Check health
    if curl -f http://localhost:3000/health > /dev/null 2>&1; then
        print_status "Services are healthy"
    else
        print_error "Services are not healthy"
        docker-compose -f docker-compose.production.yml logs
        exit 1
    fi
}

# Run database migrations
run_migrations() {
    print_info "Running database migrations..."
    
    # This would typically be done through a migration service or init container
    print_warning "Database migrations should be run manually or through your deployment pipeline"
}

# Main deployment function
main() {
    echo -e "${BLUE}Starting deployment process...${NC}"
    
    check_dependencies
    validate_environment
    run_tests
    build_docker_image
    
    # Ask user if they want to push to registry
    read -p "Do you want to push the image to the registry? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        push_docker_image
    fi
    
    # Ask user if they want to deploy locally
    read -p "Do you want to deploy locally with Docker Compose? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        deploy_with_compose
    fi
    
    print_status "Deployment process completed!"
    print_info "API is available at: http://localhost:3000"
    print_info "Health check: http://localhost:3000/health"
    print_info "API documentation: http://localhost:3000/docs"
}

# Handle script arguments
case "${1:-}" in
    "test")
        check_dependencies
        validate_environment
        run_tests
        ;;
    "build")
        check_dependencies
        validate_environment
        build_docker_image
        ;;
    "deploy")
        main
        ;;
    *)
        echo "Usage: $0 {test|build|deploy}"
        echo ""
        echo "Commands:"
        echo "  test   - Run tests and validation"
        echo "  build  - Build Docker image"
        echo "  deploy - Full deployment process"
        exit 1
        ;;
esac
