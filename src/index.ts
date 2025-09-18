import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface FanarMCPClientConfig {
  name: string;
  version: string;
  serverUrl?: string;
  serverCommand?: string;
  serverArgs?: string[];
  maxRetries?: number;
  retryDelay?: number;
  connectionTimeout?: number;
  enableConnectionPooling?: boolean;
  maxPoolSize?: number;
}

export interface ConnectionStats {
  totalConnections: number;
  successfulConnections: number;
  failedConnections: number;
  averageConnectionTime: number;
  lastConnectionTime: number;
}

export class FanarMCPClient {
  private client: Client;
  private transport!: StdioClientTransport | StreamableHTTPClientTransport;
  private isConnected = false;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly connectionTimeout: number;
  private readonly enableConnectionPooling: boolean;
  private readonly maxPoolSize: number;
  private connectionAttempts = 0;
  private connectionStartTime = 0;
  private connectionStats: ConnectionStats = {
    totalConnections: 0,
    successfulConnections: 0,
    failedConnections: 0,
    averageConnectionTime: 0,
    lastConnectionTime: 0
  };
  private connectionPool: Set<Promise<void>> = new Set();
  private lastActivityTime = Date.now();
  
  // Circuit breaker pattern
  private failureCount = 0;
  private readonly failureThreshold = 5;
  private readonly recoveryTimeout = 30000; // 30 seconds
  private lastFailureTime = 0;
  private circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(config: FanarMCPClientConfig) {
    this.maxRetries = Math.max(1, Math.min(10, config.maxRetries || 3));
    this.retryDelay = Math.max(100, Math.min(10000, config.retryDelay || 1000));
    this.connectionTimeout = Math.max(5000, Math.min(120000, config.connectionTimeout || 30000));
    this.enableConnectionPooling = config.enableConnectionPooling ?? true;
    this.maxPoolSize = Math.max(1, Math.min(10, config.maxPoolSize || 3));

    this.client = new Client({
      name: config.name,
      version: config.version
    });

    // Initialize transport based on configuration
    this.initializeTransport(config);
  }

  private initializeTransport(config: FanarMCPClientConfig): void {
    if (config.serverCommand) {
      this.transport = new StdioClientTransport({
        command: config.serverCommand,
        args: config.serverArgs || []
      });
    } else if (config.serverUrl) {
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.serverUrl)
      );
    } else {
      // Default to stdio with node and fanar-mcp-server
      this.transport = new StdioClientTransport({
        command: "npx",
        args: ["@danijeun/fanar-mcp-server"],
        env: {
          ...process.env,
          FANAR_API_KEY: process.env.FANAR_API_KEY || ""
        }
      });
    }
  }

  /**
   * Check if circuit breaker is open
   */
  private isCircuitOpen(): boolean {
    if (this.circuitState === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
        this.circuitState = 'HALF_OPEN';
        console.log('🔄 Circuit breaker transitioning to HALF_OPEN state');
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Record a failure for circuit breaker
   */
  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.circuitState = 'OPEN';
      console.warn('⚠️ Circuit breaker opened due to repeated failures');
    }
  }

  /**
   * Record a success for circuit breaker
   */
  private recordSuccess(): void {
    this.failureCount = 0;
    if (this.circuitState === 'HALF_OPEN') {
      this.circuitState = 'CLOSED';
      console.log('✅ Circuit breaker closed after successful recovery');
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      this.updateLastActivity();
      return; // Already connected
    }

    // Check circuit breaker
    if (this.isCircuitOpen()) {
      throw new Error('Circuit breaker is open - too many recent failures');
    }

    // Check connection pool if enabled
    if (this.enableConnectionPooling && this.connectionPool.size >= this.maxPoolSize) {
      await this.waitForAvailableConnection();
    }

    const connectionPromise = this.attemptConnection();
    
    if (this.enableConnectionPooling) {
      this.connectionPool.add(connectionPromise);
      connectionPromise.finally(() => this.connectionPool.delete(connectionPromise));
    }

    await connectionPromise;
  }

  private async waitForAvailableConnection(): Promise<void> {
    const maxWaitTime = 30000; // 30 seconds max wait
    const startTime = Date.now();
    
    while (this.connectionPool.size >= this.maxPoolSize) {
      if (Date.now() - startTime > maxWaitTime) {
        throw new Error('Connection pool timeout - too many concurrent connection attempts');
      }
      await this.sleep(100);
    }
  }

  private async attemptConnection(): Promise<void> {
    this.connectionStartTime = Date.now();
    this.connectionStats.totalConnections++;

    const attemptConnection = async (): Promise<void> => {
      try {
        // Set connection timeout with AbortController for better cleanup
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.connectionTimeout);

        const connectPromise = this.client.connect(this.transport);
        
        try {
          await Promise.race([
            connectPromise,
            new Promise<never>((_, reject) => {
              controller.signal.addEventListener('abort', () => 
                reject(new Error(`Connection timeout after ${this.connectionTimeout}ms`))
              );
            })
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
        
        this.isConnected = true;
        this.connectionAttempts = 0;
        this.updateConnectionStats(true);
        this.updateLastActivity();
        this.recordSuccess();
        
        console.log("✅ Connected to Fanar MCP server successfully");
      } catch (error) {
        this.connectionAttempts++;
        this.updateConnectionStats(false);
        this.recordFailure();
        throw error;
      }
    };

    // Implement exponential backoff retry logic
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await attemptConnection();
        return;
      } catch (error) {
        if (attempt === this.maxRetries) {
          console.error(`❌ Failed to connect after ${this.maxRetries} attempts:`, error);
          throw error;
        }
        
        const delay = this.calculateBackoffDelay(attempt);
        console.warn(`⚠️ Connection attempt ${attempt} failed, retrying in ${delay}ms...`);
        await this.sleep(delay);
      }
    }
  }

  private calculateBackoffDelay(attempt: number): number {
    // Exponential backoff with jitter to prevent thundering herd
    const baseDelay = this.retryDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.1 * baseDelay; // 10% jitter
    return Math.min(baseDelay + jitter, 10000); // Cap at 10 seconds
  }

  private updateConnectionStats(success: boolean): void {
    const connectionTime = Date.now() - this.connectionStartTime;
    
    if (success) {
      this.connectionStats.successfulConnections++;
      this.connectionStats.lastConnectionTime = connectionTime;
      
      // Update average connection time
      const totalTime = this.connectionStats.averageConnectionTime * (this.connectionStats.successfulConnections - 1) + connectionTime;
      this.connectionStats.averageConnectionTime = totalTime / this.connectionStats.successfulConnections;
    } else {
      this.connectionStats.failedConnections++;
    }
  }

  private updateLastActivity(): void {
    this.lastActivityTime = Date.now();
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return; // Already disconnected
    }

    try {
      await this.client.close();
      this.isConnected = false;
      console.log("✅ Disconnected from MCP server");
    } catch (error) {
      console.error("❌ Error during disconnect:", error);
      // Force disconnect state even if close fails
      this.isConnected = false;
    }
  }

  async listTools(): Promise<any> {
    await this.ensureConnected();
    
    try {
      const tools = await this.client.listTools();
      this.updateLastActivity();
      this.recordSuccess();
      return tools;
    } catch (error) {
      console.error("❌ Failed to list tools:", error);
      this.recordFailure();
      throw this.enhanceError(error, 'listTools');
    }
  }

  async callTool(toolName: string, arguments_: Record<string, any>): Promise<any> {
    await this.ensureConnected();
    
    if (!toolName?.trim()) {
      throw new Error("Tool name cannot be empty");
    }

    try {
      console.log(`[MCP][Tool] Calling: ${toolName}`);
      const result = await this.client.callTool({
        name: toolName,
        arguments: arguments_
      });
      
      this.updateLastActivity();
      this.recordSuccess();
      
      // Log result summary with better formatting
      this.logToolResult(toolName, result);
      
      return result;
    } catch (error) {
      console.error(`❌ Failed to call tool ${toolName}:`, error);
      this.recordFailure();
      throw this.enhanceError(error, 'callTool', { toolName });
    }
  }

  private logToolResult(toolName: string, result: any): void {
    try {
      const resultStr = JSON.stringify(result);
      const summary = resultStr.length > 200 ? `${resultStr.slice(0, 200)}…` : resultStr;
      console.log(`[MCP][Tool] Result received for: ${toolName} → ${summary}`);
    } catch {
      console.log(`[MCP][Tool] Result received for: ${toolName} → [unserializable-result]`);
    }
  }

  async listResources(): Promise<any> {
    await this.ensureConnected();
    
    try {
      const resources = await this.client.listResources();
      this.updateLastActivity();
      this.recordSuccess();
      return resources;
    } catch (error) {
      console.error("❌ Failed to list resources:", error);
      this.recordFailure();
      throw this.enhanceError(error, 'listResources');
    }
  }

  async readResource(uri: string): Promise<any> {
    await this.ensureConnected();
    
    if (!uri?.trim()) {
      throw new Error("Resource URI cannot be empty");
    }

    try {
      const resource = await this.client.readResource({ uri });
      this.updateLastActivity();
      this.recordSuccess();
      return resource;
    } catch (error) {
      console.error(`❌ Failed to read resource ${uri}:`, error);
      this.recordFailure();
      throw this.enhanceError(error, 'readResource', { uri });
    }
  }

  async listPrompts(): Promise<any> {
    await this.ensureConnected();
    
    try {
      const prompts = await this.client.listPrompts();
      this.updateLastActivity();
      this.recordSuccess();
      return prompts;
    } catch (error) {
      console.error("❌ Failed to list prompts:", error);
      this.recordFailure();
      throw this.enhanceError(error, 'listPrompts');
    }
  }

  async getPrompt(promptName: string, arguments_?: Record<string, any>): Promise<any> {
    await this.ensureConnected();
    
    if (!promptName?.trim()) {
      throw new Error("Prompt name cannot be empty");
    }

    try {
      const prompt = await this.client.getPrompt({
        name: promptName,
        arguments: arguments_ || {}
      });
      this.updateLastActivity();
      this.recordSuccess();
      return prompt;
    } catch (error) {
      console.error(`❌ Failed to get prompt ${promptName}:`, error);
      this.recordFailure();
      throw this.enhanceError(error, 'getPrompt', { promptName });
    }
  }

  isConnectedToServer(): boolean {
    return this.isConnected;
  }

  /**
   * Check if connection is idle and should be refreshed
   */
  isConnectionIdle(maxIdleTime: number = 300000): boolean { // 5 minutes default
    return Date.now() - this.lastActivityTime > maxIdleTime;
  }

  /**
   * Ensure client is connected before making requests
   */
  private async ensureConnected(): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Client not connected. Call connect() first.");
    }
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Enhance error messages with context
   */
  private enhanceError(error: any, operation: string, context?: Record<string, any>): Error {
    const contextStr = context ? ` (${JSON.stringify(context)})` : '';
    const enhancedMessage = `MCP operation '${operation}' failed${contextStr}: ${error instanceof Error ? error.message : String(error)}`;
    
    if (error instanceof Error) {
      error.message = enhancedMessage;
      return error;
    } else {
      return new Error(enhancedMessage);
    }
  }

  /**
   * Get connection status and statistics
   */
  getConnectionInfo(): {
    isConnected: boolean;
    connectionAttempts: number;
    maxRetries: number;
    retryDelay: number;
    connectionStats: ConnectionStats;
    lastActivity: number;
    isIdle: boolean;
    circuitState: string;
    failureCount: number;
  } {
    return {
      isConnected: this.isConnected,
      connectionAttempts: this.connectionAttempts,
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelay,
      connectionStats: { ...this.connectionStats },
      lastActivity: this.lastActivityTime,
      isIdle: this.isConnectionIdle(),
      circuitState: this.circuitState,
      failureCount: this.failureCount
    };
  }

  /**
   * Health check for the connection
   */
  async healthCheck(): Promise<{ healthy: boolean; details: string }> {
    try {
      if (!this.isConnected) {
        return { healthy: false, details: 'Not connected' };
      }

      // Check circuit breaker state
      if (this.circuitState === 'OPEN') {
        return { healthy: false, details: 'Circuit breaker is open due to repeated failures' };
      }

      // Try a lightweight operation
      await this.client.listTools();
      return { healthy: true, details: 'Connection active and responsive' };
    } catch (error) {
      return { 
        healthy: false, 
        details: `Health check failed: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }

  /**
   * Reset circuit breaker manually
   */
  resetCircuitBreaker(): void {
    this.circuitState = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = 0;
    console.log('🔄 Circuit breaker manually reset');
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(): {
    state: string;
    failureCount: number;
    lastFailureTime: number;
    threshold: number;
    recoveryTimeout: number;
  } {
    return {
      state: this.circuitState,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      threshold: this.failureThreshold,
      recoveryTimeout: this.recoveryTimeout
    };
  }
}

// Example usage
async function main() {
  const client = new FanarMCPClient({
    name: "fanar-mcp-client",
    version: "1.0.0",
    maxRetries: 3,
    retryDelay: 1000,
    connectionTimeout: 30000
  });

  try {
    // Connect to the server
    await client.connect();

    // List available tools
    const tools = await client.listTools();

    // List available resources
    const resources = await client.listResources();

    // List available prompts
    const prompts = await client.listPrompts();

    // Example: Call a tool (replace with actual tool name from the server)
    // const result = await client.callTool("example-tool", { param: "value" });

    // Example: Read a resource (replace with actual resource URI)
    // const resource = await client.readResource("file:///example.txt");

    // Example: Get a prompt (replace with actual prompt name)
    // const prompt = await client.getPrompt("example-prompt", { arg: "value" });

  } catch (error) {
    console.error("Error:", error);
  } finally {
    // Disconnect from the server
    await client.disconnect();
  }
}

// Run the example if this file is executed directly
if (process.argv[1] && process.argv[1].includes('index.js')) {
  main().catch(console.error);
} 