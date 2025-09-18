import { LLMModelInterface, LLMMessage, LLMResponse } from "./prompt-engineered-llm.js";

/**
 * Fanar LLM API Interface
 */
export class FanarInterface implements LLMModelInterface {
  private apiKey: string;
  private baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly requestTimeout: number;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    maxRetries?: number;
    retryDelay?: number;
    requestTimeout?: number;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.fanar.qa/v1";
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.requestTimeout = config.requestTimeout || 60000; // 60 seconds
  }

  async createChatCompletion(messages: LLMMessage[], config: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<LLMResponse> {
    // Validate inputs
    if (!this.apiKey?.trim()) {
      throw new Error("API key is required");
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Messages array cannot be empty");
    }

    // Filter and format messages for Fanar API
    const formattedMessages = this.formatMessages(messages);

    // Ensure we have at least one message
    if (formattedMessages.length === 0) {
      throw new Error("No valid messages to send to Fanar API");
    }

    const requestBody = {
      model: "Fanar",
      messages: formattedMessages,
      max_tokens: Math.min(config.maxTokens || 1000, 4000), // Cap at 4000
      temperature: Math.max(0, Math.min(config.temperature || 0.7, 2)) // Clamp between 0 and 2
    };

    console.log("📤 Sending request to Fanar API");

    // Implement retry logic
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.makeRequest(requestBody);
        return this.processResponse(response);
      } catch (error) {
        if (attempt === this.maxRetries) {
          console.error("❌ All retry attempts failed for Fanar API call");
          throw error;
        }
        
        console.warn(`⚠️ Fanar API attempt ${attempt} failed, retrying in ${this.retryDelay}ms...`);
        await this.sleep(this.retryDelay);
      }
    }

    throw new Error("Unexpected error in createChatCompletion");
  }

  /**
   * Format messages for Fanar API
   */
  private formatMessages(messages: LLMMessage[]): Array<{ role: string; content: string }> {
    return messages
      .filter(msg => msg.role !== "observation") // Remove observation messages
      .map(msg => {
        // Convert system messages to user messages if needed
        const role = msg.role === "system" ? "user" : msg.role;
        return {
          role: role,
          content: msg.content
        };
      })
      .filter(msg => msg.content && msg.content.trim().length > 0); // Remove empty messages
  }

  /**
   * Make HTTP request to Fanar API
   */
  private async makeRequest(requestBody: any): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "User-Agent": "Fanar-MCP-Client/1.0.0"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Fanar API error response:", errorText);
        
        // Handle specific HTTP status codes
        if (response.status === 401) {
          throw new Error("Invalid API key or authentication failed");
        } else if (response.status === 429) {
          throw new Error("Rate limit exceeded. Please try again later.");
        } else if (response.status >= 500) {
          throw new Error("Fanar API server error. Please try again later.");
        } else {
          throw new Error(`Fanar API error: ${response.status} ${response.statusText} - ${errorText}`);
        }
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.requestTimeout}ms`);
      }
      
      throw error;
    }
  }

  /**
   * Process API response
   */
  private async processResponse(response: Response): Promise<LLMResponse> {
    try {
      const data = await response.json();
      
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error("Invalid response format from Fanar API: missing choices");
      }

      const choice = data.choices[0];
      if (!choice.message || !choice.message.content) {
        throw new Error("Invalid response format from Fanar API: missing message content");
      }

      // Log usage information if available
      if (data.usage) {
        console.log(`📊 API Usage - Tokens: ${data.usage.total_tokens}, Prompt: ${data.usage.prompt_tokens}, Completion: ${data.usage.completion_tokens}`);
      }

      return {
        content: choice.message.content
      };
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Failed to parse Fanar API response");
    }
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get API configuration
   */
  getConfig(): {
    baseUrl: string;
    maxRetries: number;
    retryDelay: number;
    requestTimeout: number;
  } {
    return {
      baseUrl: this.baseUrl,
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelay,
      requestTimeout: this.requestTimeout
    };
  }

  /**
   * Validate API key format (basic check)
   */
  validateApiKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }
}

 