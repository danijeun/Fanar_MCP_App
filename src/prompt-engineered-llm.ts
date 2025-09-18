import { FanarMCPClient } from "./index.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export interface ToolCall {
  tool: string;
  parameters: Record<string, any>;
}

export interface LLMMessage {
  role: "user" | "assistant" | "observation" | "system";
  content: string;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
}

export interface PromptEngineeredLLMConfig {
  client: FanarMCPClient;
  maxTokens?: number;
  temperature?: number;
  modelInterface?: LLMModelInterface;
  enableCaching?: boolean;
  maxCacheSize?: number;
  enableToolOptimization?: boolean;
}

export interface LLMModelInterface {
  createChatCompletion(messages: LLMMessage[], config: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<LLMResponse>;
}

export class PromptEngineeredLLM {
  private client: FanarMCPClient;
  private modelInterface: LLMModelInterface;
  private maxTokens: number;
  private temperature: number;
  private tools: ToolDefinition[] = [];
  private history: LLMMessage[] = [];
  private imageCache: Map<string, { data: string; timestamp: number; size: number }> = new Map();
  private recentImageIds: string[] = [];
  private readonly maxHistoryLength = 20;
  private readonly maxContentLength = 5000;
  private readonly maxToolSteps = 6;
  private readonly maxExecutionsPerTool: Record<string, number> = {
    fanar_image_gen: 1,
    fanar_rag: 3,
    fanar_translate: 5
  };
  
  // New optimization properties
  private readonly enableCaching: boolean;
  private readonly maxCacheSize: number;
  private readonly enableToolOptimization: boolean;
  private toolCallCache: Map<string, { result: any; timestamp: number; ttl: number }> = new Map();
  private compiledRegexPatterns: RegExp[] = [];
  private lastToolDiscovery: number = 0;
  private readonly toolDiscoveryCacheTime = 300000; // 5 minutes
  
  // Memory management
  private readonly maxImageCacheSize = 100 * 1024 * 1024; // 100MB
  private readonly imageCacheTTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly toolCacheTTL = 5 * 60 * 1000; // 5 minutes
  private lastCleanupTime = Date.now();
  private readonly cleanupInterval = 60 * 1000; // 1 minute

  constructor(config: PromptEngineeredLLMConfig) {
    this.client = config.client;
    this.modelInterface = config.modelInterface || {
      async createChatCompletion() {
        return { content: "" };
      }
    };
    this.maxTokens = config.maxTokens || 1000;
    this.temperature = config.temperature || 0.7;
    this.enableCaching = config.enableCaching ?? true;
    this.maxCacheSize = config.maxCacheSize || 100;
    this.enableToolOptimization = config.enableToolOptimization ?? true;
    
    // Pre-compile regex patterns for better performance
    this.compileRegexPatterns();
    
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  private compileRegexPatterns(): void {
    // Optimized regex patterns with better performance
    this.compiledRegexPatterns = [
      /```tool_json\s*\n([\s\S]*?)\n```/g,
      /```json\s*\n([\s\S]*?)\n```/g,
      /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[\s\S]*?\}\s*\}/g
    ];
  }

  /**
   * Start periodic cleanup of caches
   */
  private startPeriodicCleanup(): void {
    setInterval(() => {
      this.cleanupCaches();
    }, this.cleanupInterval);
  }

  /**
   * Clean up expired and oversized caches
   */
  private cleanupCaches(): void {
    const now = Date.now();
    
    // Clean up tool call cache
    for (const [key, cached] of this.toolCallCache.entries()) {
      if (now - cached.timestamp > cached.ttl) {
        this.toolCallCache.delete(key);
      }
    }
    
    // Clean up image cache
    this.cleanupImageCache();
    
    this.lastCleanupTime = now;
  }

  /**
   * Initialize the LLM by fetching available tools from the MCP server
   */
  async initialize(): Promise<void> {
    try {
      // Check if we need to refresh tool discovery
      if (this.shouldRefreshToolDiscovery()) {
        const toolsResponse = await this.client.listTools();
        this.tools = this.parseToolsFromMCP(toolsResponse);
        this.lastToolDiscovery = Date.now();
        console.log(`✅ Initialized with ${this.tools.length} tools`);
      } else {
        console.log(`✅ Using cached tools (${this.tools.length} tools)`);
      }
    } catch (error) {
      console.error("❌ Failed to initialize tools:", error);
      throw error;
    }
  }

  private shouldRefreshToolDiscovery(): boolean {
    return this.tools.length === 0 || 
           (Date.now() - this.lastToolDiscovery) > this.toolDiscoveryCacheTime;
  }

  /**
   * Generate a response using prompt engineering for function calling
   */
  async generateResponse(userPrompt: string): Promise<string> {
    try {
      // Reset recent image list for this request
      this.recentImageIds = [];
      
      // Validate input
      if (!userPrompt?.trim()) {
        throw new Error("User prompt cannot be empty");
      }

      // Add user message to history
      this.addToHistory({
        role: "user",
        content: userPrompt.trim()
      });

      // Create system prompt with tool instructions
      const systemPrompt = this.createSystemPrompt();
      
      // Prepare messages for the LLM
      const messages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...this.history
      ];

      // Get initial response from LLM
      let response = await this.modelInterface.createChatCompletion(messages, {
        maxTokens: this.maxTokens,
        temperature: this.temperature
      });

      let responseContent = response.content;

      // Process tool calls using optimized pattern matching
      let stepsExecuted = 0;
      const executedToolCounts: Record<string, number> = {};

      while (stepsExecuted < this.maxToolSteps) {
        const toolCalls = this.extractToolCallsOptimized(responseContent);
        if (toolCalls.length === 0) {
          break;
        }

        // Batch tool calls for better performance
        const toolResults = await this.executeToolCallsBatch(toolCalls, executedToolCounts);
        
        // Add results to history
        for (const result of toolResults) {
          this.addToHistory({
            role: "observation",
            content: result
          });
        }

        // Ask the LLM again with all new observations
        const updatedMessages: LLMMessage[] = [
          { role: "system", content: systemPrompt },
          ...this.history
        ];
        
        response = await this.modelInterface.createChatCompletion(updatedMessages, {
          maxTokens: this.maxTokens,
          temperature: this.temperature
        });
        
        responseContent = response.content;
        stepsExecuted += 1;
      }

      // If tools were executed, ensure we get a comprehensive final response
      if (stepsExecuted > 0) {
        responseContent = await this.generateFinalResponse(systemPrompt, userPrompt);
      }

      // Post-process to keep language simple and clear
      responseContent = this.simplifyResponse(responseContent);

      // Add final assistant response to history
      this.addToHistory({
        role: "assistant",
        content: responseContent
      });

      return responseContent;
    } catch (error) {
      console.error("❌ Error in generateResponse:", error);
      const errorMessage = `Error processing request: ${error instanceof Error ? error.message : String(error)}`;
      
      // Add error to history
      this.addToHistory({
        role: "assistant",
        content: errorMessage
      });
      
      return errorMessage;
    }
  }

  /**
   * Execute multiple tool calls in batch for better performance
   */
  private async executeToolCallsBatch(
    toolCalls: ToolCall[], 
    executedToolCounts: Record<string, number>
  ): Promise<string[]> {
    const results: string[] = [];
    
    for (const toolCall of toolCalls) {
      // Enforce per-tool execution limits per turn
      const currentCount = executedToolCounts[toolCall.tool] || 0;
      const maxForTool = this.maxExecutionsPerTool[toolCall.tool] ?? Infinity;
      
      if (currentCount >= maxForTool) {
        console.warn(`[MCP][Tool] Skipping ${toolCall.tool} due to per-turn limit (${maxForTool})`);
        continue;
      }

      // Log tool execution
      console.log(`[MCP][Tool] Executing ${toolCall.tool}...`);

      // Add assistant message with tool call
      this.addToHistory({
        role: "assistant",
        content: JSON.stringify(toolCall)
      });

      // Execute the tool with caching if enabled
      const result = await this.dispatchToolWithCache(toolCall.tool, toolCall.parameters);
      console.log(`[MCP][Tool] Execution completed: ${toolCall.tool}`);

      // Format the results for the LLM
      const formattedResults = this.formatToolResults(result, toolCall.tool);
      results.push(formattedResults);

      executedToolCounts[toolCall.tool] = currentCount + 1;
    }
    
    return results;
  }

  /**
   * Generate final comprehensive response after tool execution
   */
  private async generateFinalResponse(systemPrompt: string, userPrompt: string): Promise<string> {
    const finalPrompt = `You have completed all necessary tool calls. Now provide a comprehensive final response that:
1. Summarizes what was accomplished
2. Addresses all aspects of the user's request
3. Uses complete sentences and proper grammar

User's original request: "${userPrompt}"

Please provide your final comprehensive response:`;
    
    const finalMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.history,
      { role: "user", content: finalPrompt }
    ];
    
    const finalResponse = await this.modelInterface.createChatCompletion(finalMessages, {
      maxTokens: this.maxTokens,
      temperature: this.temperature
    });
    
    return finalResponse.content;
  }

  /**
   * Create the system prompt with tool instructions
   */
  private createSystemPrompt(): string {
    const toolExample = this.createToolExample();
    const toolsInstructions = this.createToolsInstructions();
    const returnFormat = '{"tool": "tool name", "parameters": {"parameter name": "parameter value"}}';

    return `You are an AI assistant with access to powerful Fanar tools. Follow these rules:

1. RESPONSE FORMAT:
   - For SIMPLE requests (greetings, basic questions): Respond naturally and concisely
   - For COMPLEX requests (requiring tools): Use JSON tool calls, then provide comprehensive final response

2. TOOL USAGE:
   - When a tool is needed, respond with ONLY this JSON format:
   \`\`\`tool_json
   ${returnFormat}
   \`\`\`
   - For multiple tools, execute them sequentially (one at a time)
   - Wait for each tool's result before proceeding

3. FINAL RESPONSE REQUIREMENTS:
   - After completing all tool calls, provide a comprehensive summary
   - Address all aspects of the user's request
   - Use complete sentences and proper grammar
   - Be helpful and informative

4. IMAGE GENERATION:
   - Generate at most ONE image per request unless explicitly asked for more
   - Acknowledge successful generation and describe the content

5. TOOL CATEGORIES:
   - fanar_image_gen: Create images from text prompts
   - fanar_rag: Answer questions with context and references
   - fanar_image_understanding: Analyze image content
   - fanar_thinking_mode: Complex reasoning and analysis
   - fanar_translate: Translate text between languages

6. IMPORTANT:
   - Use exact tool names from the available tools list
   - Include all required parameters
   - For translation, use proper language codes (e.g., "en-ar")
   - If a tool fails, acknowledge the error and suggest alternatives

${toolExample}

Available tools:
${toolsInstructions}

Remember: Keep responses natural and friendly for simple requests, comprehensive for complex ones.`;
  }

  /**
   * Simplify the final response text to keep it clear and symbol-free
   */
  private simplifyResponse(content: string): string {
    if (!content) return "";

    let text = content;

    // Remove code fences and backticks
    text = text.replace(/```/g, "");
    text = text.replace(/`/g, "");

    // Remove inline hash comments like " # translated to ..."
    text = text.replace(/\s#.*$/gm, "");

    // Remove bracketed markers like [IMAGE_GENERATED], [TOOL_EXECUTED]
    text = text.replace(/\[[A-Z0-9_ ]+\]\s*/g, "");

    // Remove boilerplate/meta preambles and unwanted phrases
    const removalPatterns: RegExp[] = [
      /\b(?:based on the guidelines)[^\n]*:?\s*/gi,
      /\b(?:based on the executed tool calls)[^\n]*:?\s*/gi,
      /\b(?:after executing[^\n]*tool call[^\n]*)\:?\s*/gi,
      /\b(?:after|following|upon)\s+(?:executing|running|calling|using)\s+(?:the\s+)?(?:requested\s+)?(?:tool|tools)[^\n]*\.?\s*/gi,
      /\b(?:we|i)\s+(?:used|utilized|called|invoked|ran)\s+(?:the\s+)?(?:fanar_[a-z_]+|tool|tools)[^\n]*\.?\s*/gi,
      /\b(?:specifically|namely)\s+"?fanar_[a-z_]+"?,?\s*/gi,
      /\bhere is (?:my )?(?:the )?(?:final|comprehensive) (?:response|answer)[^\n]*:?\s*/gi,
      /\bas an ai[^\n]*\.?\s*/gi,
      /\bthe answer should not contain this\b\s*/gi,
      /\bfinal response\s*:\s*/gi
    ];
    for (const pattern of removalPatterns) {
      text = text.replace(pattern, "");
    }

    // Remove explicit tool identifiers if mentioned anywhere
    const toolNamePattern = /\bfanar(?:_[a-z_]+|[ \-_]+image(?:[ \-_]*understanding)?|[ \-_]+rag|[ \-_]+translate|[ \-_]+thinking(?:[ \-_]*mode)?)\b/gi;
    text = text.replace(toolNamePattern, "");

    // Remove any remaining sentences that reference tools or their execution
    try {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const toolRef = /\b(fanar(?:_[a-z_]+|[ \-_]+image(?:[ \-_]*understanding)?|[ \-_]+rag|[ \-_]+translate|[ \-_]+thinking(?:[ \-_]*mode)?)|tool|tools|execut(?:e|ed|ing)|utili(?:s|z)ed|employ(?:ed|ing)|called|invok(?:ed|ing))\b/i;
      const filtered = sentences.filter(s => !toolRef.test(s));
      if (filtered.length > 0) {
        text = filtered.join(' ');
      }
    } catch {
      // Fallback: if sentence splitting fails, proceed with current text
    }

    // Unwrap ["..."] or ['...'] to plain text
    const arrayMatch = text.match(/^\s*\[\s*(['"])(.+?)\1\s*\]\s*$/s);
    if (arrayMatch) {
      text = arrayMatch[2];
    }

    // Remove surrounding quotes if the whole string is quoted
    const quoteMatch = text.match(/^\s*(['"])(.+?)\1\s*$/s);
    if (quoteMatch) {
      text = quoteMatch[2];
    }

    // Collapse multiple spaces and newlines; trim
    text = text.replace(/[\t ]+/g, " ");
    text = text.replace(/\s*\n\s*/g, "\n");
    text = text.trim();

    return text;
  }

  /**
   * Create tool example for the prompt
   */
  private createToolExample(): string {
    return `EXAMPLE TOOL CALL FORMAT:

When you need to use a tool, respond with ONLY this format:

\`\`\`tool_json
{"tool": "tool_name", "parameters": {"param1": "value1", "param2": "value2"}}
\`\`\`

FANAR TOOL EXAMPLES:

1. IMAGE GENERATION:
   User: "create an image of a dog"
   Response:
   \`\`\`tool_json
   {"tool": "fanar_image_gen", "parameters": {"prompt": "a beautiful dog"}}
   \`\`\`

2. TRANSLATION:
   User: "translate 'hello world' to Arabic"
   Response:
   \`\`\`tool_json
   {"tool": "fanar_translate", "parameters": {"text": "hello world", "langpair": "en-ar"}}
   \`\`\`

3. RAG:
   User: "answer questions about AI using RAG"
   Response:
   \`\`\`tool_json
   {"tool": "fanar_rag", "parameters": {"messages": [{"role": "user", "content": "What is artificial intelligence?"}], "model": "Fanar"}}
   \`\`\`

4. IMAGE UNDERSTANDING:
   User: "analyze this image and describe what you see"
   Response:
   \`\`\`tool_json
   {"tool": "fanar_image_understanding", "parameters": {"prompt": "Describe what you see in this image", "image_b64": "base64_encoded_image_data", "model": "Fanar"}}
   \`\`\`

5. THINKING MODE:
   User: "think through this complex problem step by step"
   Response:
   \`\`\`tool_json
   {"tool": "fanar_thinking_mode", "parameters": {"user_input": "Solve this complex problem step by step", "model": "Fanar"}}
   \`\`\`

IMPORTANT: 
- ONLY respond with the JSON when using a tool
- NO explanations or additional text
- Use the exact tool name from the available tools list
- Include all required parameters`;
  }

  /**
   * Create tools instructions from available tools
   */
  private createToolsInstructions(): string {
    let instructions = "";
    
    for (const tool of this.tools) {
      const requiredParams = tool.parameters.required || [];
      const properties = tool.parameters.properties || {};
      
      instructions += `TOOL: ${tool.name}
DESCRIPTION: ${tool.description}
REQUIRED PARAMETERS: ${requiredParams.join(", ")}
PARAMETER DETAILS: ${JSON.stringify(properties, null, 2)}

`;
    }
    
    return instructions;
  }

  /**
   * Parse tools from MCP response format
   */
  private parseToolsFromMCP(mcpTools: any): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    
    if (mcpTools && mcpTools.tools) {
      for (const tool of mcpTools.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema || {
            type: "object",
            properties: {},
            required: []
          }
        });
      }
    }
    
    return tools;
  }

  /**
   * Extract multiple tool calls from content across several possible patterns.
   * Returns calls in the order they appear in the content.
   */
  private extractToolCallsOptimized(content: string): ToolCall[] {
    type IndexedCall = { index: number; call: ToolCall };
    const indexedCalls: IndexedCall[] = [];

    for (const pattern of this.compiledRegexPatterns) {
      let match: RegExpExecArray | null;
      
      while ((match = pattern.exec(content)) !== null) {
        let jsonContent: string;
        
        if (pattern.source.includes('```')) {
          jsonContent = (match[1] || '').trim();
        } else {
          jsonContent = (match[0] || '').trim();
        }
        
        try {
          const parsed = JSON.parse(jsonContent);
          if (parsed && parsed.tool && parsed.parameters) {
            indexedCalls.push({
              index: match.index,
              call: { tool: parsed.tool, parameters: parsed.parameters }
            });
          }
        } catch (error) {
          // Log parsing errors for debugging
          console.debug(`Failed to parse tool call JSON: ${jsonContent}`, error);
        }
      }
    }

    // Sort by appearance order and remove duplicates while preserving order
    indexedCalls.sort((a, b) => a.index - b.index);
    const seen = new Set<string>();
    const result: ToolCall[] = [];
    
    for (const { call } of indexedCalls) {
      const sig = `${call.tool}:${JSON.stringify(call.parameters)}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        result.push(call);
      }
    }
    
    return result;
  }

  /**
   * Dispatch tool call with caching if enabled
   */
  private async dispatchToolWithCache(toolName: string, parameters: Record<string, any>): Promise<string> {
    if (!this.enableCaching) {
      return this.dispatchTool(toolName, parameters);
    }

    const cacheKey = this.generateCacheKey(toolName, parameters);
    const cached = this.toolCallCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < cached.ttl) {
      console.log(`[MCP][Cache] Using cached result for ${toolName}`);
      return cached.result;
    }

    const result = await this.dispatchTool(toolName, parameters);
    
    // Cache the result with TTL
    this.cacheToolResult(cacheKey, result);
    
    return result;
  }

  private generateCacheKey(toolName: string, parameters: Record<string, any>): string {
    const sortedParams = Object.keys(parameters)
      .sort()
      .map(key => `${key}:${JSON.stringify(parameters[key])}`)
      .join('|');
    return `${toolName}:${sortedParams}`;
  }

  private cacheToolResult(key: string, result: string): void {
    if (this.toolCallCache.size >= this.maxCacheSize) {
      // Remove oldest entries (simple LRU)
      const firstKey = this.toolCallCache.keys().next().value;
      if (firstKey !== undefined) {
        this.toolCallCache.delete(firstKey);
      }
    }
    
    this.toolCallCache.set(key, {
      result,
      timestamp: Date.now(),
      ttl: this.toolCacheTTL
    });
  }

  /**
   * Dispatch tool call to MCP server
   */
  private async dispatchTool(toolName: string, parameters: Record<string, any>): Promise<string> {
    try {
      const result = await this.client.callTool(toolName, parameters);
      return JSON.stringify(result);
    } catch (error) {
      console.error(`Failed to call tool ${toolName}:`, error);
      return `Error calling tool ${toolName}: ${error}`;
    }
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Get conversation history
   */
  getHistory(): LLMMessage[] {
    return [...this.history];
  }

  /**
   * Manage conversation history to prevent context length issues
   */
  private manageHistory(): void {
    if (this.history.length > this.maxHistoryLength) {
      // Keep only the most recent messages
      this.history = this.history.slice(-this.maxHistoryLength);
      console.log("📝 History truncated to prevent context length issues");
    }
    
    // Truncate long messages
    this.history = this.history.map(message => ({
      ...message,
      content: message.content.length > this.maxContentLength 
        ? message.content.substring(0, this.maxContentLength) + '...' 
        : message.content
    }));
  }

  /**
   * Add message to history with automatic management
   */
  private addToHistory(message: LLMMessage): void {
    this.history.push(message);
    this.manageHistory();
  }

  /**
   * Get cached image data by ID
   */
  getCachedImage(imageId: string): string | undefined {
    const cached = this.imageCache.get(imageId);
    if (cached) {
      // Update timestamp for LRU behavior
      cached.timestamp = Date.now();
      return cached.data;
    }
    return undefined;
  }

  /**
   * Clear image cache
   */
  clearImageCache(): void {
    this.imageCache.clear();
    console.log("🗑️ Image cache cleared");
  }

  /**
   * Get all cached image IDs
   */
  getCachedImageIds(): string[] {
    return Array.from(this.imageCache.keys());
  }

  /**
   * Get image cache information for monitoring
   */
  getImageCacheInfo(): {
    totalImages: number;
    totalSize: number;
    oldestImage: number;
    newestImage: number;
    cacheSize: number;
  } {
    const now = Date.now();
    let totalSize = 0;
    let oldestImage = now;
    let newestImage = 0;

    for (const [_, cached] of this.imageCache.entries()) {
      totalSize += cached.size || cached.data.length;
      oldestImage = Math.min(oldestImage, cached.timestamp);
      newestImage = Math.max(newestImage, cached.timestamp);
    }

    return {
      totalImages: this.imageCache.size,
      totalSize,
      oldestImage: oldestImage === now ? 0 : oldestImage,
      newestImage,
      cacheSize: this.maxCacheSize
    };
  }

  /**
   * Get images generated during the most recent call and clear the recent list
   */
  getAndClearRecentlyGeneratedImages(): { id: string; data: string }[] {
    const images = this.recentImageIds
      .map((id) => {
        const data = this.imageCache.get(id);
        return data ? { id, data: data.data } : undefined;
      })
      .filter((x): x is { id: string; data: string } => Boolean(x));

    // Clear recent list after retrieval
    this.recentImageIds = [];
    return images;
  }

  /**
   * Clean up old cached images (LRU cleanup)
   */
  private cleanupImageCache(): void {
    const now = Date.now();
    const maxAge = this.imageCacheTTL;
    
    // Calculate total cache size
    let totalSize = 0;
    const entries = Array.from(this.imageCache.entries());
    
    for (const [_, cached] of entries) {
      totalSize += cached.size || cached.data.length;
    }
    
    // Remove expired entries first
    for (const [id, cached] of entries) {
      if (now - cached.timestamp > maxAge) {
        this.imageCache.delete(id);
        totalSize -= cached.size || cached.data.length;
      }
    }
    
    // If still over size limit, remove oldest entries
    if (totalSize > this.maxImageCacheSize) {
      const sortedEntries = entries
        .filter(([_, cached]) => now - cached.timestamp <= maxAge)
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      for (const [id, cached] of sortedEntries) {
        if (totalSize <= this.maxImageCacheSize) break;
        
        this.imageCache.delete(id);
        totalSize -= cached.size || cached.data.length;
      }
    }
  }

  /**
   * Format tool results for LLM consumption
   */
  private formatToolResults(results: any, toolName: string): string {
    if (typeof results === 'string') {
      try {
        const parsed = JSON.parse(results);
        
        // Handle different result structures
        if (parsed.content && Array.isArray(parsed.content)) {
          // Handle content array format
          const imageContent = parsed.content.find((item: any) => item.type === 'image');
          const textContent = parsed.content.find((item: any) => item.type === 'text');
          
          if (imageContent) {
            return this.handleImageContent(imageContent, toolName);
          } else if (textContent) {
            // Handle text content
            return textContent.text || 'Tool executed successfully';
          } else {
            // Handle other content types
            const resultStr = JSON.stringify(parsed.content);
            return this.truncateResult(`${toolName} completed successfully. Result: ${resultStr}`);
          }
        } else if (parsed.content && typeof parsed.content === 'string') {
          // Handle direct content string
          return this.truncateResult(`${toolName} completed successfully. Result: ${parsed.content}`);
        } else if (parsed.data) {
          // Handle data field - check if it's image data
          return this.handleDataField(parsed.data, toolName);
        } else {
          // Fallback for other structures
          const resultStr = JSON.stringify(parsed);
          return this.truncateResult(`${toolName} completed successfully. Result: ${resultStr}`);
        }
      } catch (error) {
        // If not JSON, truncate if too long
        return this.truncateResult(`${toolName} completed successfully. Result: ${results}`);
      }
    } else {
      // Handle non-string results
      const resultStr = JSON.stringify(results);
      return this.truncateResult(`${resultStr}`);
    }
  }

  /**
   * Handle image content from tool results
   */
  private handleImageContent(imageContent: any, toolName: string): string {
    const imageData = imageContent.data || '';
    const dataLength = imageData.length;
    
    if (dataLength > 1000) {
      // Store large image data in cache
      const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Handle different image data formats
      let processedImageData = imageData;
      if (imageData.startsWith('data:image')) {
        // Extract base64 part from data URL
        const base64Match = imageData.match(/data:image\/[^;]+;base64,(.+)/);
        if (base64Match) {
          processedImageData = base64Match[1];
        }
      }
      
      this.imageCache.set(imageId, { 
        data: processedImageData, 
        timestamp: Date.now(),
        size: processedImageData.length
      });
      this.recentImageIds.push(imageId);
      
      return `Successfully generated an image (ID: ${imageId}). The image was created based on your prompt.`;
    } else {
      return `Successfully generated an image.`;
    }
  }

  /**
   * Handle data field from tool results
   */
  private handleDataField(data: any, toolName: string): string {
    if (typeof data === 'string' && data.length > 1000) {
      // Check if this looks like image data (base64)
      if (data.startsWith('data:image') || data.length > 10000) {
        const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Handle different image data formats
        let processedImageData = data;
        if (data.startsWith('data:image')) {
          // Extract base64 part from data URL
          const base64Match = data.match(/data:image\/[^;]+;base64,(.+)/);
          if (base64Match) {
            processedImageData = base64Match[1];
          }
        }
        
        this.imageCache.set(imageId, { 
          data: processedImageData, 
          timestamp: Date.now(),
          size: processedImageData.length
        });
        this.recentImageIds.push(imageId);
        return `Successfully generated an image (ID: ${imageId}).`;
      } else {
        return `${toolName} successfully generated data (${data.length} characters).`;
      }
    }
    return `${toolName} successfully generated data.`;
  }

  /**
   * Truncate long results
   */
  private truncateResult(result: string, maxLength: number = 500): string {
    if (result.length > maxLength) {
      return `${result.substring(0, maxLength)}...`;
    }
    return result;
  }
}

