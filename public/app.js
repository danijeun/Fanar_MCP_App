// Fanar LLM Web App Frontend
// Silence frontend logging
(function() {
    const ENABLE_LOGS = false;
    if (!ENABLE_LOGS) {
        ['log', 'debug', 'info', 'warn'].forEach(method => {
            try { console[method] = () => {}; } catch (_) {}
        });
    }
})();
class FanarWebApp {
    constructor() {
        this.apiBase = '/api';
        this.isConnected = false;
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.checkConnection();
        this.updateStatus('online', 'Connected');
    }

    setupEventListeners() {
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const openTranscriptBtn = document.getElementById('open-transcript');
        const transcriptModal = document.getElementById('transcript-modal');
        const closeTranscriptBtn = document.getElementById('close-transcript');
        const copyTranscriptBtn = document.getElementById('copy-transcript');
        const transcriptContent = document.getElementById('transcript-content');

        console.log('🔍 Setting up event listeners...');
        console.log('📝 Message input found:', messageInput);
        console.log('📤 Send button found:', sendButton);

        if (!messageInput) {
            console.error('❌ Message input not found!');
            return;
        }

        if (!sendButton) {
            console.error('❌ Send button not found!');
            return;
        }

        // Test button state and position
        console.log('🔍 Send button state:', {
            disabled: sendButton.disabled,
            type: sendButton.type,
            className: sendButton.className,
            style: sendButton.style.cssText,
            offsetWidth: sendButton.offsetWidth,
            offsetHeight: sendButton.offsetHeight,
            clientWidth: sendButton.clientWidth,
            clientHeight: sendButton.clientHeight
        });

        // Check if button is visible and clickable
        const rect = sendButton.getBoundingClientRect();
        console.log('🔍 Send button position:', {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0
        });

        // Add a visual test - change button color briefly
        sendButton.addEventListener('mouseenter', () => {
            console.log('🖱️ Mouse entered send button');
            sendButton.style.background = '#10b981'; // Green color
        });

        sendButton.addEventListener('mouseleave', () => {
            sendButton.style.background = ''; // Reset to default
        });

        // Send message on Enter (Shift+Enter for new line)
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                console.log('⌨️ Enter key pressed, sending message...');
                this.sendMessage();
            }
        });

        // Send button click - try multiple approaches
        sendButton.addEventListener('click', (e) => {
            console.log('🖱️ Send button clicked!');
            e.preventDefault();
            e.stopPropagation();
            
            // Check if button is disabled
            if (sendButton.disabled) {
                console.log('⚠️ Send button is disabled');
                return;
            }
            
            // Check if there's a message to send
            const message = messageInput.value.trim();
            if (!message) {
                console.log('⚠️ No message to send');
                return;
            }
            
            console.log('📤 Sending message:', message);
            this.sendMessage();
        });

        // Also handle clicks on the icon inside the button
        const sendButtonIcon = sendButton.querySelector('i');
        if (sendButtonIcon) {
            sendButtonIcon.addEventListener('click', (e) => {
                console.log('🖱️ Send button icon clicked!');
                e.preventDefault();
                e.stopPropagation();
                
                // Check if button is disabled
                if (sendButton.disabled) {
                    console.log('⚠️ Send button is disabled');
                    return;
                }
                
                // Check if there's a message to send
                const message = messageInput.value.trim();
                if (!message) {
                    console.log('⚠️ No message to send');
                    return;
                }
                
                console.log('📤 Sending message:', message);
                this.sendMessage();
            });
        }

        // Try alternative event listeners
        sendButton.addEventListener('mousedown', (e) => {
            console.log('🖱️ Send button mousedown!');
        });

        sendButton.addEventListener('mouseup', (e) => {
            console.log('🖱️ Send button mouseup!');
        });

        // Try touch events for mobile
        sendButton.addEventListener('touchstart', (e) => {
            console.log('👆 Send button touchstart!');
        });

        sendButton.addEventListener('touchend', (e) => {
            console.log('👆 Send button touchend!');
            e.preventDefault();
            this.sendMessage();
        });

        // Direct test - add a simple alert to see if button is working
        sendButton.onclick = (e) => {
            console.log('🎯 Direct onclick handler triggered!');
            e.preventDefault();
            e.stopPropagation();
            this.sendMessage();
        };

        // Also try adding the event listener to the parent container
        const inputWrapper = document.querySelector('.input-wrapper');
        if (inputWrapper) {
            inputWrapper.addEventListener('click', (e) => {
                if (e.target === sendButton || e.target.closest('#send-button')) {
                    console.log('🎯 Click detected through parent container!');
                    e.preventDefault();
                    e.stopPropagation();
                    this.sendMessage();
                }
            });
        }

        // Add a global click handler as a last resort
        document.addEventListener('click', (e) => {
            if (e.target === sendButton || e.target.closest('#send-button')) {
                console.log('🎯 Global click detected on send button!');
                e.preventDefault();
                e.stopPropagation();
                
                // Check if there's a message to send
                const message = messageInput.value.trim();
                if (!message) {
                    console.log('⚠️ No message to send');
                    return;
                }
                
                console.log('📤 Sending message:', message);
                this.sendMessage();
            }
        });

        // Auto-resize textarea
        messageInput.addEventListener('input', () => {
            this.autoResizeTextarea(messageInput);
        });

        // Header buttons
        const externalLinkBtn = document.querySelector('.external-link-icon');

        externalLinkBtn.addEventListener('click', () => {
            this.openExternalLink();
        });

        // Keyboard shortcuts for testing
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + L to toggle background logo (for testing)
            if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
                e.preventDefault();
                if (document.body.classList.contains('show-background-logo')) {
                    this.hideBackgroundLogo();
                    console.log('🖼️ Background logo hidden manually');
                } else {
                    this.showBackgroundLogo();
                    console.log('🖼️ Background logo shown manually');
                }
            }

            // Ctrl/Cmd + Shift + T to open transcript
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
                e.preventDefault();
                this.openTranscript();
            }
        });

        // Transcript controls
        if (openTranscriptBtn) {
            openTranscriptBtn.addEventListener('click', () => this.openTranscript());
        }
        if (closeTranscriptBtn) {
            closeTranscriptBtn.addEventListener('click', () => this.closeTranscript());
        }
        if (copyTranscriptBtn) {
            copyTranscriptBtn.addEventListener('click', async () => {
                const text = transcriptContent ? (transcriptContent.textContent || '') : '';
                try {
                    await navigator.clipboard.writeText(text);
                } catch (err) {
                    console.error('Failed to copy transcript:', err);
                }
            });
        }
        if (transcriptModal) {
            transcriptModal.addEventListener('click', (e) => {
                if (e.target === transcriptModal) this.closeTranscript();
            });
        }
        console.log('✅ Event listeners set up successfully');
    }

    autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    async checkConnection() {
        try {
            const response = await fetch(`${this.apiBase}/health`);
            const data = await response.json();
            this.isConnected = data.status === 'ok';
            return this.isConnected;
        } catch (error) {
            console.error('Connection check failed:', error);
            this.isConnected = false;
            return false;
        }
    }

    updateStatus(status, text) {
        console.log(`Status: ${status} - ${text}`);
    }

    // Show background logo when images are being processed
    showBackgroundLogo() {
        document.body.classList.add('show-background-logo');
    }

    // Hide background logo when images are not being processed
    hideBackgroundLogo() {
        document.body.classList.remove('show-background-logo');
    }

    // Force hide background logo (for manual control)
    forceHideBackgroundLogo() {
        document.body.classList.remove('show-background-logo');
    }

    async openTranscript() {
        const modal = document.getElementById('transcript-modal');
        const contentEl = document.getElementById('transcript-content');
        if (!modal || !contentEl) return;

        try {
            const res = await fetch(`${this.apiBase}/history`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const lines = (data.history || []).map((m) => {
                const role = (m.role || 'unknown').toUpperCase();
                const text = (m.content || '').toString();
                return `[${role}] ${text}`;
            });
            contentEl.textContent = lines.join('\n\n');
        } catch (err) {
            console.error('Failed to load transcript:', err);
            contentEl.textContent = 'Failed to load transcript.';
        }

        modal.classList.remove('hidden');
    }

    closeTranscript() {
        const modal = document.getElementById('transcript-modal');
        if (modal) modal.classList.add('hidden');
    }

    async sendMessage() {
        console.log('🚀 sendMessage method called');
        
        const messageInput = document.getElementById('message-input');
        const message = messageInput.value.trim();
        
        console.log('📝 Message content:', message);
        
        if (!message) {
            console.log('⚠️ No message to send, returning');
            return;
        }

        console.log('✅ Message is valid, proceeding...');

        // Check if this might be an image request
        const isImageRequest = this.isImageRequest(message);
        
        // Show background logo if it's an image request
        if (isImageRequest) {
            console.log('🖼️ Image request detected, showing background logo');
            this.showBackgroundLogo();
        } else {
            console.log('💬 Non-image request detected, background logo will remain hidden');
        }

        // Add user message to chat
        this.addMessage('user', message);
        messageInput.value = '';
        this.autoResizeTextarea(messageInput);

        // Show loading
        this.showLoading(true);

        try {
            console.log('🌐 Making API request to:', `${this.apiBase}/chat`);
            console.log('📤 Request payload:', { message });
            
            const response = await fetch(`${this.apiBase}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message })
            });

            console.log('📥 Response status:', response.status);
            console.log('📥 Response headers:', response.headers);
            
            if (!response.ok) {
                console.error('❌ HTTP error:', response.status, response.statusText);
                const errorText = await response.text();
                console.error('❌ Error response:', errorText);
                this.addMessage('assistant', `Error: HTTP ${response.status} - ${response.statusText}`);
                this.hideBackgroundLogo();
                return;
            }

            const data = await response.json();
            console.log('📥 Response data:', data);
            
            if (data.error) {
                console.error('❌ API error:', data.error);
                this.addMessage('assistant', `Error: ${data.error}`);
                this.hideBackgroundLogo();
            } else {
                // Handle response with potential images
                console.log('📸 Received response with images:', data.images);
                this.addMessage('assistant', data.response, data.images);
                
                // Check if this was actually an image generation or something else
                const isImageGeneration = data.images && data.images.length > 0;
                const isTranslationResponse = data.response.toLowerCase().includes('translation') || 
                                           data.response.toLowerCase().includes('translate') ||
                                           data.response.toLowerCase().includes('سلام') ||
                                           data.response.toLowerCase().includes('arabic');
                
                if (!isImageGeneration || isTranslationResponse) {
                    console.log('🖼️ Not an image generation, hiding background logo');
                    this.hideBackgroundLogo();
                } else {
                    // Hide background logo after processing with a small delay
                    setTimeout(() => {
                        this.hideBackgroundLogo();
                    }, 1000);
                }
            }
        } catch (error) {
            console.error('❌ Failed to send message:', error);
            console.error('❌ Error details:', {
                name: error.name,
                message: error.message,
                stack: error.stack
            });
            this.addMessage('assistant', 'Sorry, I encountered an error. Please try again.');
            this.hideBackgroundLogo();
        } finally {
            this.showLoading(false);
        }
    }

    // Check if the message is likely an image request
    isImageRequest(message) {
        const lowerMessage = message.toLowerCase();
        
        // First, check for explicit exclusions (non-image requests)
        const exclusions = [
            'translate', 'translation', 'language', 'word', 'text', 'meaning',
            'dictionary', 'definition', 'synonym', 'antonym', 'pronunciation',
            'rag', 'search', 'find', 'lookup', 'question', 'answer', 'help',
            'explain', 'describe', 'tell me', 'what is', 'how to', 'why',
            'thinking', 'reason', 'analyze', 'compare', 'difference',
            'peace', 'hello', 'hi', 'goodbye', 'thanks', 'thank you'
        ];
        
        // If any exclusion is found, it's not an image request
        const matchedExclusion = exclusions.find(exclusion => lowerMessage.includes(exclusion));
        if (matchedExclusion) {
            console.log(`🚫 Exclusion found: "${matchedExclusion}" - not an image request`);
            return false;
        }
        
        // Specific image request phrases (high confidence)
        const imagePhrases = [
            'create an image', 'generate an image', 'make a picture', 'draw a',
            'show me a', 'can you create', 'i want to see', 'need a picture of',
            'looking for an image', 'generate a', 'create a', 'make a',
            'create a picture', 'generate a picture', 'make an image',
            'draw an image', 'paint a', 'illustrate', 'visualize'
        ];
        
        // Check for exact phrases first
        const hasImagePhrase = imagePhrases.some(phrase => {
            if (lowerMessage.includes(phrase)) {
                console.log(`✅ Image phrase found: "${phrase}" - likely image request`);
                return true;
            }
            return false;
        });
        if (hasImagePhrase) return true;
        
        // Specific image-related keywords (medium confidence)
        const imageKeywords = [
            'image', 'picture', 'photo', 'generate', 'create', 'draw', 'make',
            'painting', 'drawing', 'illustration', 'graphic', 'visual', 'art'
        ];
        
        // Check for keywords only if they appear in the right context
        const hasImageKeyword = imageKeywords.some(keyword => {
            if (lowerMessage.includes(keyword)) {
                // Additional context check to avoid false positives
                const contextWords = ['of', 'a', 'an', 'the', 'this', 'that', 'my', 'your'];
                const words = lowerMessage.split(' ');
                const keywordIndex = words.findIndex(word => word.includes(keyword));
                
                // Check if the keyword is followed by context words or is part of a clear image request
                if (keywordIndex !== -1) {
                    const nextWord = words[keywordIndex + 1];
                    const prevWord = words[keywordIndex - 1];
                    
                    // If keyword is followed by context words or preceded by action words, it's likely an image request
                    const isImageRequest = contextWords.includes(nextWord) || 
                           ['create', 'generate', 'make', 'draw', 'show', 'display'].includes(prevWord) ||
                           lowerMessage.includes(`${keyword} of`) ||
                           lowerMessage.includes(`a ${keyword}`) ||
                           lowerMessage.includes(`an ${keyword}`);
                    
                    if (isImageRequest) {
                        console.log(`✅ Image keyword found in context: "${keyword}" - likely image request`);
                        return true;
                    }
                }
            }
            return false;
        });
        
        if (hasImageKeyword) return true;
        
        // Check for common image request patterns
        const imagePatterns = [
            /(create|generate|make|draw)\s+(an?\s+)?(image|picture|photo|art)/i,
            /(show|display)\s+(me\s+)?(an?\s+)?(image|picture|photo)/i,
            /(want|need)\s+(to\s+)?(see|get|have)\s+(an?\s+)?(image|picture|photo)/i,
            /(can\s+you\s+)?(create|generate|make|draw)\s+(an?\s+)?(image|picture|photo|art)/i
        ];
        
        const hasImagePattern = imagePatterns.some(pattern => pattern.test(lowerMessage));
        if (hasImagePattern) {
            console.log(`✅ Image pattern found - likely image request`);
            return true;
        }
        
        console.log(`❌ No image request indicators found`);
        return false;
    }

    addMessage(role, content, images = []) {
        const chatMessages = document.getElementById('chat-messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        
        // Convert markdown-like formatting to HTML
        const formattedContent = this.formatMessage(content);
        contentDiv.innerHTML = formattedContent;
        
        // Add images if available
        if (images && images.length > 0) {
            console.log('🖼️ Processing images:', images);
            images.forEach(image => {
                console.log('🖼️ Processing image:', image.id, 'Data length:', image.data.length);
                const imgElement = document.createElement('img');
                
                // Handle different image data formats
                let imageSrc;
                if (image.data.startsWith('data:image')) {
                    // Already a data URL
                    imageSrc = image.data;
                    console.log('🖼️ Using data URL format');
                } else {
                    // Base64 data - create data URL
                    imageSrc = `data:${image.mimeType || 'image/png'};base64,${image.data}`;
                    console.log('🖼️ Using base64 format');
                }
                
                imgElement.src = imageSrc;
                imgElement.alt = 'Generated image';
                imgElement.className = 'generated-image';
                imgElement.style.maxWidth = '100%';
                imgElement.style.height = 'auto';
                imgElement.style.borderRadius = '8px';
                imgElement.style.marginTop = '10px';
                imgElement.style.boxShadow = '0 4px 8px rgba(0,0,0,0.1)';
                
                // Add click handler to open image in new tab
                imgElement.addEventListener('click', () => {
                    window.open(imageSrc, '_blank');
                });
                
                contentDiv.appendChild(imgElement);
                console.log('🖼️ Image added to DOM');
            });
        }
        
        messageDiv.appendChild(contentDiv);
        
        chatMessages.appendChild(messageDiv);
        
        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    formatMessage(content) {
        // Simple markdown-like formatting
        return content
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
    }

    showLoading(show) {
        const loadingOverlay = document.getElementById('loading-overlay');
        const sendButton = document.getElementById('send-button');
        
        if (show) {
            loadingOverlay.classList.remove('hidden');
            sendButton.disabled = true;
        } else {
            loadingOverlay.classList.add('hidden');
            sendButton.disabled = false;
        }
    }





    openExternalLink() {
        window.open('https://fanar.qa', '_blank');
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new FanarWebApp();
}); 