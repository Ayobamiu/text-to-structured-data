# AI Data Extractor

A minimal Node.js API that integrates with the Flask PDF extraction service to provide structured data extraction using OpenAI.

## Features

- **File Upload**: Accepts PDF files via multipart form data
- **Schema-Driven**: Uses JSON schemas to define extraction structure
- **Flask Integration**: Calls the Python microservice for PDF text extraction
- **OpenAI Processing**: Uses GPT-4 for structured data extraction
- **Minimal Design**: Clean, focused API with standard practices
- **Comprehensive Logging**: Detailed request/response logging for debugging

## Project Structure

```
ai/
├── src/
│   ├── data/
│   │   ├── example_schema.json          # Example extraction schema
│   │   └── mgs_well_data_schema.json    # Well log specific schema
│   └── server.js                        # Main Express server
├── package.json                         # Dependencies
├── README.md                           # This file
└── .gitignore                          # Git ignore rules
```

## Installation

```bash
npm install
```

## Usage

### Start the server:

```bash
npm start
# or
node src/server.js
```

Server runs on `http://localhost:3000`

### API Endpoints

#### Health Check

```bash
GET /health
```

#### Extract Data

```bash
POST /extract
Content-Type: multipart/form-data
Body:
  - file: PDF file
  - schema: JSON schema string
  - schemaName: Schema name (optional)
```

### Example Request

```bash
curl -X POST http://localhost:3000/extract \
  -F "file=@document.pdf" \
  -F "schema={\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}},\"required\":[\"title\",\"content\"]}" \
  -F "schemaName=document_extraction"
```

### Example Schema Files

- `src/data/example_schema.json` - General purpose extraction schema
- `src/data/mgs_well_data_schema.json` - Well log specific schema

### Example Response

```json
{
  "success": true,
  "data": {
    "title": "Document Title",
    "content": "Extracted content..."
  },
  "metadata": {
    "filename": "document.pdf",
    "textLength": 1234,
    "pagesProcessed": 5
  }
}
```

## Environment Variables

```env
OPENAI_API_KEY=your_openai_api_key
FLASK_URL=http://localhost:5001
PORT=3000
```

## Architecture

1. **File Upload**: Receives PDF + schema via multipart form
2. **Text Extraction**: Calls Flask service `/extract-text` endpoint
3. **AI Processing**: Sends extracted text + schema to OpenAI
4. **Response**: Returns structured data in JSON format

## Dependencies

- **express**: Web framework
- **multer**: File upload handling
- **axios**: HTTP client for Flask communication
- **openai**: OpenAI API client
- **form-data**: Multipart form data handling
