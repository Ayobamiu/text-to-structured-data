# AI Extractor Backend

A production-ready Node.js backend service for AI-powered document extraction with multi-tenant support, real-time processing, and comprehensive monitoring.

## 🚀 Features

- **AI-Powered Extraction**: OpenAI GPT-4 integration for intelligent document processing
- **Multi-Tenant Architecture**: Organization-based data isolation and user management
- **Real-Time Processing**: WebSocket-based live updates and Redis queue management
- **Cloud Storage**: AWS S3 integration for scalable file storage
- **Authentication & Security**: JWT-based auth with bcrypt password hashing
- **Database Management**: PostgreSQL with automated migrations
- **Health Monitoring**: Comprehensive health checks and metrics
- **Production Ready**: Docker containerization with CI/CD pipeline

## 📋 Prerequisites

- Node.js 18+ and npm 8+
- PostgreSQL 15+
- Redis 7+
- AWS S3 bucket
- OpenAI API key
- Docker (optional)

## 🛠️ Installation

### Local Development

1. **Clone the repository**

   ```bash
   git clone https://github.com/your-org/ai-extractor-backend.git
   cd ai-extractor-backend
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Start dependencies**

   ```bash
   docker-compose up -d postgres redis
   ```

5. **Run database migrations**

   ```bash
   npm run migrate
   ```

6. **Start the application**

   ```bash
   # Start API server
   npm run dev

   # Start worker (in another terminal)
   npm run worker:dev
   ```

### Docker Deployment

1. **Build and run with Docker Compose**

   ```bash
   docker-compose -f docker-compose.production.yml up -d
   ```

2. **Or build individual images**

   ```bash
   # Build API image
   docker build -t ai-extractor-backend .

   # Run container
   docker run -p 3000:3000 --env-file .env ai-extractor-backend
   ```

## 🔧 Configuration

### Environment Variables

| Variable                | Description        | Default                 | Required |
| ----------------------- | ------------------ | ----------------------- | -------- |
| `NODE_ENV`              | Environment mode   | `development`           | No       |
| `PORT`                  | Server port        | `3000`                  | No       |
| `DB_HOST`               | PostgreSQL host    | `localhost`             | Yes      |
| `DB_PORT`               | PostgreSQL port    | `5432`                  | Yes      |
| `DB_NAME`               | Database name      | `ai_extractor`          | Yes      |
| `DB_USER`               | Database user      | `postgres`              | Yes      |
| `DB_PASSWORD`           | Database password  | -                       | Yes      |
| `REDIS_HOST`            | Redis host         | `localhost`             | Yes      |
| `REDIS_PORT`            | Redis port         | `6379`                  | Yes      |
| `FLASK_URL`             | Flask service URL  | `http://localhost:5001` | Yes      |
| `OPENAI_API_KEY`        | OpenAI API key     | -                       | Yes      |
| `AWS_REGION`            | AWS region         | `us-east-1`             | Yes      |
| `AWS_ACCESS_KEY_ID`     | AWS access key     | -                       | Yes      |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key     | -                       | Yes      |
| `S3_BUCKET_NAME`        | S3 bucket name     | -                       | Yes      |
| `JWT_SECRET`            | JWT signing secret | -                       | Yes      |
| `API_KEY`               | API access key     | -                       | Yes      |

### Database Schema

The application uses PostgreSQL with the following main tables:

- `users` - User accounts and authentication
- `organizations` - Multi-tenant organization data
- `user_organization_memberships` - User-organization relationships
- `jobs` - Document processing jobs
- `job_files` - Individual files within jobs
- `user_sessions` - Active user sessions
- `audit_logs` - Security and activity logging

## 📡 API Endpoints

### Authentication

- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `POST /auth/logout` - User logout
- `POST /auth/refresh` - Token refresh

### Organizations

- `GET /organizations` - List user organizations
- `POST /organizations` - Create organization
- `GET /organizations/:id/members` - List organization members

### Jobs

- `GET /jobs` - List user jobs
- `POST /jobs` - Create new job
- `GET /jobs/:id` - Get job details
- `POST /jobs/:id/files` - Add files to job

### Health & Monitoring

- `GET /health` - Health check
- `GET /ready` - Readiness probe
- `GET /live` - Liveness probe

## 🔄 Processing Flow

1. **File Upload**: Users upload documents via API
2. **S3 Storage**: Files stored in AWS S3 with unique keys
3. **Queue Processing**: Files added to Redis queue for processing
4. **Text Extraction**: Flask service extracts text using Google Document AI
5. **AI Processing**: OpenAI processes extracted text with user schema
6. **Real-Time Updates**: WebSocket events notify frontend of progress
7. **Result Storage**: Structured data stored in PostgreSQL

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   API Server    │    │   Worker        │
│   (Next.js)     │◄──►│   (Express)      │◄──►│   (Node.js)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │                        │
                              ▼                        ▼
                       ┌─────────────────┐    ┌─────────────────┐
                       │   PostgreSQL     │    │   Flask Service  │
                       │   Database       │    │   (PDF Extract)  │
                       └─────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │   Redis Queue   │
                       │   & Cache       │
                       └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │   AWS S3        │
                       │   File Storage   │
                       └─────────────────┘
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## 📊 Monitoring

### Health Checks

- **Health**: `GET /health` - Comprehensive service health
- **Readiness**: `GET /ready` - Service readiness for traffic
- **Liveness**: `GET /live` - Service liveness check

### Logging

- Structured JSON logging with Pino
- Log levels: `error`, `warn`, `info`, `debug`
- Request/response logging middleware
- Error tracking and alerting

### Metrics

- Request duration and count
- Database connection pool status
- Redis queue metrics
- Worker processing statistics

## 🚀 Deployment

### Production Checklist

- [ ] Environment variables configured
- [ ] Database migrations applied
- [ ] SSL certificates installed
- [ ] Monitoring and alerting set up
- [ ] Backup strategy implemented
- [ ] Security scanning completed
- [ ] Load testing performed

### Scaling Considerations

- **Horizontal Scaling**: Multiple API server instances behind load balancer
- **Worker Scaling**: Multiple worker processes for queue processing
- **Database**: Read replicas for read-heavy operations
- **Redis**: Redis Cluster for high availability
- **Storage**: S3 with CloudFront CDN for global distribution

## 🔒 Security

- JWT-based authentication with refresh tokens
- Password hashing with bcrypt
- Rate limiting and request validation
- CORS configuration for production domains
- Helmet.js security headers
- Input sanitization and validation
- SQL injection prevention
- XSS protection

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [Wiki](https://github.com/your-org/ai-extractor-backend/wiki)
- **Issues**: [GitHub Issues](https://github.com/your-org/ai-extractor-backend/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-org/ai-extractor-backend/discussions)

## 🔗 Related Projects

- [PDF Extractor Service](https://github.com/your-org/pdf-extractor-service) - Flask microservice for PDF processing
- [Document Extractor Frontend](https://github.com/your-org/document-extractor-frontend) - Next.js web application
