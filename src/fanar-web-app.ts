#!/usr/bin/env node

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { FanarMCPClient } from "./index.js";
import { PromptEngineeredLLM } from "./prompt-engineered-llm.js";
import { FanarInterface } from "./llm-interfaces.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FanarWebAppConfig {
  fanarApiKey: string;
  port?: number;
  mcpClientName?: string;
  mcpClientVersion?: string;
  modelName?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  rateLimitWindow?: number;
  rateLimitMax?: number;
  enableHealthChecks?: boolean;
  healthCheckInterval?: number;
}

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

class FanarWebApp {
  private app: express.Application;
  private mcpClient: FanarMCPClient;
  private promptLLM: PromptEngineeredLLM;
  private modelName: string;
  private port: number;
  private rateLimitWindow: number;
  private rateLimitMax: number;
  private rateLimitStore: Map<string, RateLimitInfo> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  private static suppressLogs(): void {
    const noop = () => {};
    console.log = noop;
    console.info = noop as any;
    console.debug = noop as any;
    console.warn = noop as any;
    console.error = noop as any;
  }

  constructor(config: FanarWebAppConfig) {
    this.port = config.port || 3000;
    this.rateLimitWindow = config.rateLimitWindow || 60000; // 1 minute
    this.rateLimitMax = config.rateLimitMax || 10; // 10 requests per window
    
    // Suppress server logs only in production
    if (process.env.NODE_ENV === 'production') {
      FanarWebApp.suppressLogs();
    }
    
    // Initialize Express app
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();

    // Initialize MCP client with retry configuration
    this.mcpClient = new FanarMCPClient({
      name: config.mcpClientName || "fanar-web-app",
      version: config.mcpClientVersion || "1.0.0",
      maxRetries: 3,
      retryDelay: 1000,
      connectionTimeout: 30000,
      enableConnectionPooling: true,
      maxPoolSize: 5
    });

    // Initialize Fanar LLM interface
    const fanarLLM = new FanarInterface({
      apiKey: config.fanarApiKey,
      baseUrl: config.baseUrl || "https://api.fanar.qa/v1",
      maxRetries: 3,
      retryDelay: 1000,
      requestTimeout: 60000
    });

    // Initialize prompt engineered LLM
    this.promptLLM = new PromptEngineeredLLM({
      client: this.mcpClient,
      modelInterface: fanarLLM,
      maxTokens: config.maxTokens || 1000,
      temperature: config.temperature || 0.7,
      enableCaching: true,
      maxCacheSize: 200,
      enableToolOptimization: true
    });

    this.modelName = config.modelName || "Fanar";

    // Start health checks if enabled
    if (config.enableHealthChecks !== false) {
      this.startHealthChecks(config.healthCheckInterval || 30000);
    }
  }

  private setupMiddleware(): void {
    // Increase payload limit for image processing
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    this.app.use(express.static(path.join(__dirname, '../public')));
    
    // Add security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    });

    // Add request logging middleware
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
      });
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/api/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        model: this.modelName,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connections: this.mcpClient.getConnectionInfo()
      });
    });

    // Chat endpoint with rate limiting
    this.app.post('/api/chat', this.rateLimitMiddleware(), async (req, res) => {
      try {
        const { message, history } = req.body;
        
        // Validate input
        if (!message || typeof message !== 'string' || !message.trim()) {
          return res.status(400).json({ 
            error: 'Message is required and must be a non-empty string' 
          });
        }

        if (message.length > 10000) {
          return res.status(400).json({ 
            error: 'Message too long. Maximum length is 10,000 characters.' 
          });
        }

        console.log(`💬 Processing message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`);
        
        const response = await this.promptLLM.generateResponse(message.trim());

        // Only return images generated for this specific request
        const recentImages = this.promptLLM.getAndClearRecentlyGeneratedImages();
        const images = recentImages.map(({ id, data }) => ({ 
          id, 
          data, 
          mimeType: 'image/png' 
        }));

        res.json({
          response,
          history: this.promptLLM.getHistory(),
          images: images.length > 0 ? images : undefined,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Chat error:', error);
        res.status(500).json({ 
          error: 'Failed to process message',
          details: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Get cached image by ID
    this.app.get('/api/images/:imageId', (req, res) => {
      try {
        const { imageId } = req.params;
        
        // Validate image ID
        if (!imageId || typeof imageId !== 'string' || imageId.length > 100) {
          return res.status(400).json({ error: 'Invalid image ID' });
        }
        
        const imageData = this.promptLLM.getCachedImage(imageId);
        
        if (!imageData) {
          return res.status(404).json({ error: 'Image not found' });
        }
        
        // Set appropriate headers for image
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        // Convert base64 to buffer and send
        const buffer = Buffer.from(imageData, 'base64');
        res.send(buffer);
      } catch (error) {
        console.error('❌ Image retrieval error:', error);
        res.status(500).json({ 
          error: 'Failed to retrieve image',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Get MCP capabilities
    this.app.get('/api/capabilities', async (req, res) => {
      try {
        const tools = await this.mcpClient.listTools();
        const resources = await this.mcpClient.listResources();
        const prompts = await this.mcpClient.listPrompts();
        
        res.json({ 
          tools, 
          resources, 
          prompts,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Capabilities error:', error);
        res.status(500).json({ 
          error: 'Failed to get capabilities',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Call MCP tool
    this.app.post('/api/tools/:toolName', this.rateLimitMiddleware(), async (req, res) => {
      try {
        const { toolName } = req.params;
        const arguments_ = req.body.arguments || {};
        
        // Validate tool name
        if (!toolName || typeof toolName !== 'string' || toolName.length > 100) {
          return res.status(400).json({ error: 'Invalid tool name' });
        }
        
        console.log(`🔧 Calling MCP tool: ${toolName}`);
        const result = await this.mcpClient.callTool(toolName, arguments_);
        
        res.json({ 
          result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error(`❌ Tool call error:`, error);
        res.status(500).json({ 
          error: 'Failed to call tool',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Get conversation history
    this.app.get('/api/history', (req, res) => {
      try {
        const history = this.promptLLM.getHistory();
        res.json({ 
          history,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ History error:', error);
        res.status(500).json({ 
          error: 'Failed to get history',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Clear conversation history
    this.app.delete('/api/history', (req, res) => {
      try {
        this.promptLLM.clearHistory();
        res.json({ 
          message: 'History cleared successfully',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Clear history error:', error);
        res.status(500).json({ 
          error: 'Failed to clear history',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Get connection status
    this.app.get('/api/status', (req, res) => {
      try {
        const connectionInfo = this.mcpClient.getConnectionInfo();
        res.json({
          status: 'ok',
          connection: connectionInfo,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Status error:', error);
        res.status(500).json({ 
          error: 'Failed to get status',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Memory usage endpoint
    this.app.get('/api/memory', (req, res) => {
      try {
        const memoryUsage = process.memoryUsage();
        const imageCacheInfo = this.promptLLM.getImageCacheInfo();
        
        res.json({
          process: memoryUsage,
          imageCache: imageCacheInfo,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Memory info error:', error);
        res.status(500).json({ 
          error: 'Failed to get memory info',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Clear image cache endpoint
    this.app.delete('/api/cache/images', (req, res) => {
      try {
        this.promptLLM.clearImageCache();
        res.json({ 
          message: 'Image cache cleared successfully',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Clear cache error:', error);
        res.status(500).json({ 
          error: 'Failed to clear image cache',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Serve the main HTML page
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.originalUrl
      });
    });
  }

  /**
   * Rate limiting middleware with improved performance
   */
  private rateLimitMiddleware() {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const clientId = req.ip || 'unknown';
      const now = Date.now();
      
      // Clean up expired entries periodically (every 100 requests)
      if (Math.random() < 0.01) {
        this.cleanupExpiredRateLimits(now);
      }
      
      const clientInfo = this.rateLimitStore.get(clientId);
      
      if (!clientInfo || now > clientInfo.resetTime) {
        // New window or first request
        this.rateLimitStore.set(clientId, {
          count: 1,
          resetTime: now + this.rateLimitWindow
        });
        next();
      } else if (clientInfo.count < this.rateLimitMax) {
        // Within limit
        clientInfo.count++;
        next();
      } else {
        // Rate limit exceeded
        res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((clientInfo.resetTime - now) / 1000),
          limit: this.rateLimitMax,
          window: this.rateLimitWindow / 1000
        });
      }
    };
  }

  /**
   * Clean up expired rate limit entries
   */
  private cleanupExpiredRateLimits(now: number): void {
    for (const [key, info] of this.rateLimitStore.entries()) {
      if (now > info.resetTime) {
        this.rateLimitStore.delete(key);
      }
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(interval: number): void {
    this.healthCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;
      
      try {
        const health = await this.mcpClient.healthCheck();
        if (!health.healthy) {
          console.warn('⚠️ MCP connection health check failed:', health.details);
          // Attempt to reconnect if connection is unhealthy
          if (this.mcpClient.isConnectedToServer()) {
            console.log('🔄 Attempting to reconnect to MCP server...');
            await this.mcpClient.disconnect();
            await this.mcpClient.connect();
          }
        }
      } catch (error) {
        console.error('❌ Health check error:', error);
      }
    }, interval);
  }

  /**
   * Stop health checks
   */
  private stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async initialize(): Promise<void> {
    console.log("🚀 Initializing Fanar Web App...");
    
    try {
      // Connect to MCP server
      console.log("📡 Connecting to Fanar MCP server...");
      await this.mcpClient.connect();
      console.log("✅ MCP server connected successfully!");
      
      // Initialize prompt engineered LLM
      console.log("🧠 Initializing prompt engineered LLM...");
      await this.promptLLM.initialize();
      console.log("✅ Prompt engineered LLM initialized successfully!");
      
      // Test the system
      console.log("🧪 Testing the system...");
      const testResponse = await this.promptLLM.generateResponse("Hello! Please respond with 'Connection successful' if you can see this message.");
      console.log("✅ System test successful!");
      console.log(`🤖 Test Response: ${testResponse}`);
      
    } catch (error) {
      console.error("❌ Initialization failed:", error);
      throw new Error(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async start(): Promise<void> {
    try {
      await this.initialize();
      
      this.app.listen(this.port, () => {
        console.log(`🌐 Fanar Web App is running on http://localhost:${this.port}`);
        console.log(`📱 Open your browser and navigate to the URL above`);
        console.log(`🔧 API endpoints available at http://localhost:${this.port}/api/`);
        console.log(`📊 Rate limit: ${this.rateLimitMax} requests per ${this.rateLimitWindow / 1000} seconds`);
        console.log(`💾 Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
      });
    } catch (error) {
      console.error("❌ Failed to start web app:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.mcpClient.disconnect();
      console.log("✅ Disconnected from MCP server");
    } catch (error) {
      console.error("❌ Error during disconnect:", error);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    
    this.isShuttingDown = true;
    console.log("🔄 Shutting down Fanar Web App...");
    
    try {
      // Stop health checks
      this.stopHealthChecks();
      
      // Clear rate limit store
      this.rateLimitStore.clear();
      
      // Disconnect from MCP server
      await this.disconnect();
      
      // Clear image cache
      this.promptLLM.clearImageCache();
      
      console.log("✅ Shutdown completed successfully");
    } catch (error) {
      console.error("❌ Error during shutdown:", error);
    }
  }
}

// Example usage function
async function runFanarWebApp() {
  console.log("🚀 Fanar Web App with MCP Integration and Prompt Engineering");
  console.log("================================================================\n");

  // Get API key from environment or user input
  const apiKey = process.env.FANAR_API_KEY || "YOUR_API_KEY_HERE";
  console.log("🔑 API Key found:", apiKey ? "Yes" : "No");
  
  if (apiKey === "YOUR_API_KEY_HERE") {
    console.error("❌ Please set your Fanar API key:");
    console.log("1. Set environment variable: FANAR_API_KEY=your_key_here");
    console.log("2. Or update the apiKey in the code");
    console.log("\n💡 Example:");
    console.log("   export FANAR_API_KEY='your-fanar-api-key'");
    console.log("   node dist/fanar-web-app.js");
    process.exit(1);
  }

  console.log("✅ API Key is set, creating web app...");

  const webApp = new FanarWebApp({
    fanarApiKey: apiKey,
    port: 3000,
    mcpClientName: "fanar-web-app",
    mcpClientVersion: "1.0.0",
    modelName: "Fanar",
    baseUrl: "https://api.fanar.qa/v1",
    maxTokens: 1000,
    temperature: 0.7,
    rateLimitWindow: 60000, // 1 minute
    rateLimitMax: 10, // 10 requests per minute
    enableHealthChecks: true,
    healthCheckInterval: 30000
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log("\n🔄 Received SIGINT, shutting down gracefully...");
    await webApp.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log("\n🔄 Received SIGTERM, shutting down gracefully...");
    await webApp.shutdown();
    process.exit(0);
  });

  try {
    console.log("🔧 Starting web app...");
    await webApp.start();
  } catch (error) {
    console.error("❌ Web app failed:", error);
    console.error("Error details:", error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error("Stack trace:", error.stack);
    }
    process.exit(1);
  }
}

// Run the app if this file is executed directly
if (process.argv[1] && process.argv[1].includes('fanar-web-app.js')) {
  console.log("✅ Starting Fanar Web App...");
  runFanarWebApp().catch(console.error);
}

 