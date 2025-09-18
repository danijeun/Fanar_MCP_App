# Fanar Web App with MCP Integration

This application provides a complete web-based integration between the Fanar LLM and the Fanar MCP server, using prompt engineering to enable function calling capabilities.

## Overview

The Fanar Web App combines:
- **Fanar LLM API**: For natural language processing
- **Fanar MCP Server**: For tool and resource access
- **Prompt Engineering**: For function calling without native support
- **Web Interface**: Modern, responsive web UI similar to Cursor and Claude Desktop

## Features

✅ **Fanar LLM Integration**: Direct connection to Fanar API  
✅ **MCP Server Connection**: Automatic connection to `@danijeun/fanar-mcp-server`  
✅ **Prompt Engineering**: Function calling through prompt injection  
✅ **Tool Discovery**: Automatic discovery of available MCP tools  
✅ **Resource Access**: Read and interact with MCP resources  
✅ **Multi-turn Conversations**: Maintains conversation context  
✅ **Modern Web UI**: Beautiful, responsive web interface  
✅ **Error Handling**: Robust error handling and fallbacks  

## Setup

### 1. Install Dependencies

```bash
npm install
npm run build
```

### 2. Set Your Fanar API Key

**Windows (PowerShell):**
```powershell
$env:FANAR_API_KEY="your-fanar-api-key"
```

**Windows (Command Prompt):**
```cmd
set FANAR_API_KEY=your-fanar-api-key
```

**Linux/macOS:**
```bash
export FANAR_API_KEY="your-fanar-api-key"
```

### 3. Install the Fanar MCP Server

The app automatically uses the `@danijeun/fanar-mcp-server` package. Make sure it's available:

```bash
npm install -g @danijeun/fanar-mcp-server
```

## Usage

### Quick Start

```bash
# Set your API key (see setup section above)
# Then run the web app
npm run start
```

### Development Mode

```bash
# Run in development mode with hot reload
npm run dev
```

### Production Build

```bash
# Build and run production version
npm run web-app-built
```

## Web Interface

The web app provides a modern, responsive interface with:

- **Clean Design**: Modern UI similar to Cursor and Claude Desktop
- **Real-time Chat**: Interactive chat interface
- **Tool Integration**: Automatic tool calling through the UI
- **Conversation History**: Persistent conversation context
- **Mobile Responsive**: Works on desktop and mobile devices

### Accessing the App

Once running, open your browser and navigate to:
```
http://localhost:3000
```

## API Endpoints

The web app exposes several API endpoints:

- `GET /api/health` - Health check
- `POST /api/chat` - Send chat messages
- `GET /api/capabilities` - Get MCP capabilities
- `POST /api/tool` - Execute MCP tools
- `GET /api/history` - Get conversation history

## Code Examples

### Basic Usage

```typescript
import { FanarWebApp } from "./fanar-web-app.js";

const webApp = new FanarWebApp({
  fanarApiKey: process.env.FANAR_API_KEY!,
  port: 3000,
  mcpClientName: "fanar-web-app",
  mcpClientVersion: "1.0.0",
  modelName: "Fanar",
  baseUrl: "https://api.fanar.qa/v1",
  maxTokens: 1000,
  temperature: 0.7
});

await webApp.start();
``` 