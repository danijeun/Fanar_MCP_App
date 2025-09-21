[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/danijeun-fanar-mcp-app-badge.png)](https://mseep.ai/app/danijeun-fanar-mcp-app)

# Fanar Web App with MCP Integration

## Overview

This application demonstrates a novel implementation of the Model Context Protocol (MCP) for Large Language Models (LLMs) that lack native function calling capabilities. Specifically designed for the Fanar LLM, this project bridges the gap between traditional text-generation models and modern tool-augmented AI systems through strategic prompt engineering techniques.

### Key Innovation

The core innovation addresses a fundamental limitation in the LLM ecosystem: **most existing models, including specialized and smaller models like Fanar, cannot natively generate structured function calls required by MCP architecture**. This project eliminates the need for computationally expensive fine-tuning by implementing a prompt engineering solution that enables MCP compatibility.

### System Architecture

The application integrates three primary components:

- **Fanar LLM API**: Arabic-centric multimodal generative AI platform
- **MCP Server Infrastructure**: Standardized tool and resource access layer  
- **Prompt Engineering Layer**: Function calling enablement without native support
- **Web Interface**: Modern, responsive chat interface

### Benefits

✅ **Cost-Effective**: Avoids expensive fine-tuning requirements  
✅ **Reversible**: Prompt-based approach allows easy modification  
✅ **Generalizable**: Methodology applicable to other non-function calling LLMs  
✅ **Production-Ready**: Full web application with robust error handling  
✅ **Standards-Compliant**: Adheres to official MCP specification  

## Deployment

### Prerequisites

- Node.js v18.x or higher
- npm package manager
- Fanar API key from [Fanar Platform](https://api.fanar.qa)

### Quick Start

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd fanar-mcp-web-app
   npm install
   npm run build
   ```

2. **Set Environment Variables**
   
   **Windows (PowerShell):**
   ```powershell
   $env:FANAR_API_KEY="your-fanar-api-key"
   ```
   
   **Linux/macOS:**
   ```bash
   export FANAR_API_KEY="your-fanar-api-key"
   ```

3. **Install MCP Server**
   ```bash
   npm install -g @danijeun/fanar-mcp-server
   ```

4. **Launch Application**
   ```bash
   npm run start
   ```

5. **Access Interface**
   ```
   http://localhost:3000
   ```

### Production Deployment

```bash
# Build optimized production version
npm run build

# Run production server
npm run web-app-built
```

### Development Mode

```bash
# Hot reload development server
npm run dev
```

### Configuration Options

```typescript
const config = {
  fanarApiKey: process.env.FANAR_API_KEY,    // Required
  port: 3000,                                // Server port
  mcpClientName: "fanar-web-app",           // MCP client identifier
  mcpClientVersion: "1.0.0",               // Version
  modelName: "Fanar",                       // Model identifier
  baseUrl: "https://api.fanar.qa/v1",       // Fanar API endpoint
  maxTokens: 1000,                          // Response length limit
  temperature: 0.7,                         // Response creativity
  rateLimitWindow: 60000,                   // Rate limit window (ms)
  rateLimitMax: 100                         // Max requests per window
};
```

## Background

### Model Context Protocol (MCP)

The Model Context Protocol, introduced by Anthropic in late 2024, represents a significant advancement in standardizing AI-tool interactions. Inspired by the Language Server Protocol (LSP), MCP provides a flexible framework for AI applications to communicate with external tools dynamically, moving beyond traditional predefined tool mappings to enable AI agents to autonomously discover, select, and orchestrate tools based on task context.

### The Function Calling Challenge

Traditional MCP implementation relies fundamentally on the model's ability to generate structured function calls in JSON format. This capability is primarily available in state-of-the-art models with explicit function calling support, such as:

- OpenAI GPT-4 series
- Anthropic Claude series  
- Google Gemini models

However, this requirement effectively excludes a substantial portion of existing LLMs, including:

- **Specialized Models**: Domain-specific models optimized for particular industries
- **Smaller Models**: Lightweight models optimized for edge deployment
- **Legacy Systems**: Older models without function calling features
- **Open Source Alternatives**: Community models that may lack this functionality
- **Regional Models**: Specialized models like Fanar for Arabic language processing

### Problem Statement

The core challenge stems from an architectural mismatch between MCP's requirements and the capabilities of non-function calling LLMs. MCP servers expect structured JSON requests conforming to specific schemas for tool invocation, while traditional LLMs generate unstructured text responses, making direct integration impossible.

### Why Prompt Engineering Over Fine-Tuning

This project chose prompt engineering over fine-tuning for several critical reasons:

1. **Resource Efficiency**: Fine-tuning requires substantial computational resources and large datasets
2. **Flexibility**: Prompt-based approaches allow dynamic tool modification without retraining
3. **Accessibility**: Works with externally hosted models where training access is restricted
4. **Reversibility**: Changes can be easily reverted or modified
5. **Speed**: Immediate implementation without lengthy training cycles

## Methodology

### MCP Architecture Implementation

The system implements a client-host-server paradigm designed to decouple the application interface from execution logic:

#### Host Application
Acts as the central coordinator, managing:
- User sessions and permissions
- Security enforcement and consent requirements
- Client lifecycle management
- Context aggregation across multiple sources
- AI model integration and sampling coordination

#### MCP Client
Functions as connection manager with:
- 1:1 server relationship maintenance
- Protocol negotiation and capability exchange
- Bidirectional message routing
- Subscription and notification management
- Security boundary enforcement between servers

#### MCP Server
Specialized service providers offering:
- Focused contextual capabilities through standardized primitives
- Independent operation with clearly defined responsibilities
- Sampling request initiation through client interfaces
- Local or remote deployment flexibility

### MCP Transport Layer

The implementation utilizes **Stdio Transport** for reliable communication:

```typescript
const transport = new StdioServerTransport();
const server = new McpServer({
  name: "fanar-mcp-server",
  version: "1.0.0"
});
```

This transport establishes communication through subprocess architecture where the client launches the MCP server as a child process and manages bidirectional message exchange via standard input/output streams.

### Prompt Engineering Technique for Function Calling

The core innovation lies in a two-phase prompt engineering approach that enables function calling without native support:

#### Phase 1: Prompt Injection

Dynamic tool information injection into the system prompt:

```typescript
// Tool discovery and injection
const tools = await mcpClient.listTools();
let toolsInstructions = "";

for (const tool of tools) {
  toolsInstructions += `${tool.name}: Call this tool to interact with ${tool.name}. `;
  toolsInstructions += `Description: ${tool.description}. `;
  toolsInstructions += `Parameters: ${JSON.stringify(tool.parameters)}. `;
  toolsInstructions += `Required: ${tool.required || []}.\n`;
}

const TOOL_EXAMPLE = `
You will receive a JSON string containing callable tools. 
Return a JSON object with tool name and parameters.
Example format: {"tool": "tool_name", "parameters": {"param": "value"}}
`;

const RETURN_FORMAT = '{"tool": "tool name", "parameters": {"parameter name": "parameter value"}}';

const INSTRUCTION = `
${TOOL_EXAMPLE}
Answer questions using available APIs: ${toolsInstructions}
Use format: '''tool_json ${RETURN_FORMAT} '''
Choose appropriate tools based on user questions.
Respond directly if no tool needed.
Match user's language in responses.
Stop calling tools when sufficient information gathered.
`;
```

#### Phase 2: Tool Result Feedback

Systematic extraction and feedback loop management:

```typescript
// Tool call extraction using regex patterns
const toolPattern = /\{"tool":\s*"([^"]+)",\s*"parameters":\s*({[^}]*})\}/g;

function extractToolCalls(content: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  let match;
  
  while ((match = toolPattern.exec(content)) !== null) {
    try {
      const toolName = match[1];
      const parameters = JSON.parse(match[2]);
      toolCalls.push({ tool: toolName, parameters });
    } catch (error) {
      console.debug(`Failed to parse tool call: ${match[0]}`);
    }
  }
  
  return toolCalls;
}

// Execution and feedback integration
async function executeToolLoop(userPrompt: string): Promise<string> {
  let response = await generateInitialResponse(userPrompt);
  let stepsExecuted = 0;
  const maxSteps = 5;
  
  while (stepsExecuted < maxSteps) {
    const toolCalls = extractToolCalls(response);
    if (toolCalls.length === 0) break;
    
    for (const call of toolCalls) {
      const result = await mcpClient.callTool(call.tool, call.parameters);
      
      // Add tool result to conversation context
      conversationHistory.push({
        role: "observation", 
        content: result
      });
    }
    
    response = await continueGeneration();
    stepsExecuted++;
  }
  
  return response;
}
```

### Error Handling and Resilience

The system implements multiple layers of fault tolerance:

#### Circuit Breaker Pattern
```typescript
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private readonly failureThreshold = 5;
  private readonly recoveryTimeout = 30000;
  
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      throw new Error('Circuit breaker is OPEN');
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
}
```

#### Exponential Backoff Retry
```typescript
async function retryWithBackoff<T>(
  operation: () => Promise<T>, 
  maxRetries: number = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      const jitter = Math.random() * 0.1 * delay;
      await sleep(delay + jitter);
    }
  }
  throw new Error('Max retries exceeded');
}
```

### API Integration

The web application exposes RESTful endpoints for comprehensive interaction:

```typescript
// Chat endpoint with comprehensive response
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const response = await promptLLM.generateResponse(message.trim());
    
    res.json({
      response,
      history: promptLLM.getHistory(),
      images: promptLLM.getRecentImages(),
      timestamp: new Date().toISOString(),
      toolsUsed: promptLLM.getLastToolsUsed()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Processing failed',
      details: error.message
    });
  }
});

// Direct tool execution
app.post('/api/tools/:toolName', async (req, res) => {
  const { toolName } = req.params;
  const args = req.body.arguments || {};
  
  const result = await mcpClient.callTool(toolName, args);
  res.json({ result, timestamp: new Date().toISOString() });
});
```

### Performance Optimizations

#### Connection Pooling
Manages resource utilization through bounded connection pools with timeout mechanisms.

#### Tool Discovery Caching  
Implements 5-minute cache retention for tool definitions, balancing freshness with performance.

#### Batch Tool Execution
Parallelizes independent tool calls while respecting dependency constraints.

#### Response Streaming
Supports real-time response streaming for improved user experience.

## References

[1] Anthropic. 2024. Introducing the Model Context Protocol. https://www.anthropic.com/news/model-context-protocol

[2] Qatar Computing Research Institute (QCRI). 2025. Fanar, An Arabic-Centric Multimodal Generative AI Platform. arXiv preprint arXiv:2501.13944v1

[3] Valenzuela, D.J. 2025. Model Context Protocol (MCP) Implementation for Non-Function Calling/Tools Support LLMs. New Jersey Institute of Technology

[4] OpenAI. 2023. Function calling in OpenAI models. https://platform.openai.com/docs/guides/functions

[5] Wei, J., Wang, X., Schuurmans, D., et al. 2022. Chain of Thought Prompting Elicits Reasoning in Large Language Models. arXiv:2201.11903

[6] Sahoo, P. 2024. A Systematic Survey of Prompt Engineering in Large Language Models: Techniques and Applications. arXiv:2402.07927

[7] He, S. 2024. Achieving tool calling functionality in LLMs using only prompt engineering without fine-tuning. arXiv:2407.04997v1

[8] Model Context Protocol. 2025. TypeScript SDK. https://github.com/modelcontextprotocol/typescript-sdk

[9] Anthropic. 2025. Model Context Protocol specification: Architecture. https://modelcontextprotocol.io/specification/2025-06-18/architecture

[10] Hasan, M.M., et al. 2024. Model Context Protocol (MCP) at First Glance: Studying the Security and Maintainability of MCP Servers. arXiv:2506.13538v1