// Background Service Worker for Add to NotebookLM
// Handles API calls and message passing between content scripts and popup

importScripts('lib/youtube-comments-api.js', 'lib/comments-to-md.js');

// ============================================
// Utilities
// ============================================

// Rate Limiter - prevents excessive API calls
const RateLimiter = {
  lastCall: 0,
  minInterval: 500, // Minimum 500ms between API calls
  queue: [],

  async throttle(fn) {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCall;

    if (timeSinceLastCall < this.minInterval) {
      // Wait for remaining time
      await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastCall));
    }

    this.lastCall = Date.now();
    return await fn();
  }
};

// Response Validator - validates API responses
const ResponseValidator = {
  /**
   * Validate that response is from expected origin
   */
  validateOrigin(url, expectedOrigin) {
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL');
    }

    try {
      const urlObj = new URL(url);
      if (!urlObj.origin.includes(expectedOrigin)) {
        throw new Error(`Invalid response origin: expected ${expectedOrigin}, got ${urlObj.origin}`);
      }
    } catch (error) {
      throw new Error(`Invalid URL format: ${error.message}`);
    }
  },

  /**
   * Validate RPC response structure
   */
  validateRpcResponse(responseText) {
    if (!responseText || typeof responseText !== 'string') {
      throw new Error('Invalid RPC response: expected string, got ' + typeof responseText);
    }

    // Check for common error patterns
    if (responseText.includes('"error"') || responseText.includes('Error')) {
      console.warn('Possible error in RPC response');
    }

    return true;
  },

  /**
   * Validate notebook ID format (UUID)
   */
  validateNotebookId(id) {
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!id || !uuidRegex.test(id)) {
      throw new Error(`Invalid notebook ID format: ${id}`);
    }
    return true;
  },

  /**
   * Validate URL format
   */
  validateUrl(url) {
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL: must be a string');
    }

    try {
      new URL(url);
    } catch (error) {
      throw new Error(`Invalid URL format: ${url}`);
    }

    return true;
  }
};

// Enhanced Error Handler
const ErrorHandler = {
  /**
   * Map error to user-friendly message with multi-language support
   */
  getUserFriendlyMessage(error) {
    // Detect language (can be extended to read from chrome.storage)
    const lang = navigator.language || 'en';

    const errorMap = {
      'Failed to fetch': {
        en: 'Network error. Please check your internet connection.',
        ru: 'Ошибка сети. Проверьте подключение к интернету.',
        uk: 'Помилка мережі. Перевірте підключення до Інтернету.'
      },
      'Not authorized': {
        en: 'Please login to NotebookLM first.',
        ru: 'Пожалуйста, войдите в NotebookLM.',
        uk: 'Спочатку увійдіть до NotebookLM.'
      },
      'Invalid notebook ID': {
        en: 'Invalid notebook selected. Please try again.',
        ru: 'Выбран недействительный блокнот. Попробуйте снова.',
        uk: 'Обрано недійсний нотатник. Спробуйте ще раз.'
      },
      'Invalid URL': {
        en: 'Invalid URL provided. Please check the address.',
        ru: 'Указан недействительный URL. Проверьте адрес.',
        uk: 'Вказано недійсний URL. Перевірте адресу.'
      },
      'AbortError': {
        en: 'Request timeout. Please try again.',
        ru: 'Превышено время ожидания. Попробуйте снова.',
        uk: 'Перевищено час очікування. Спробуйте ще раз.'
      },
      'Invalid response origin': {
        en: 'Security error: unexpected response source.',
        ru: 'Ошибка безопасности: неожиданный источник ответа.',
        uk: 'Помилка безпеки: неочікуване джерело відповіді.'
      },
    };

    const defaultMessages = {
      en: 'An unexpected error occurred. Please try again.',
      ru: 'Произошла неожиданная ошибка. Попробуйте снова.',
      uk: 'Сталася неочікувана помилка. Спробуйте ще раз.'
    };

    const errorMessage = error.message || error.toString();

    // Find matching error
    for (const [key, messages] of Object.entries(errorMap)) {
      if (errorMessage.includes(key)) {
        if (lang.startsWith('uk')) return messages.uk;
        if (lang.startsWith('ru')) return messages.ru;
        return messages.en;
      }
    }

    // Return default message
    if (lang.startsWith('uk')) return defaultMessages.uk;
    if (lang.startsWith('ru')) return defaultMessages.ru;
    return defaultMessages.en;
  },

  /**
   * Log error with context
   */
  logError(context, error, additionalInfo = {}) {
    console.error(`[${context}]`, error.message || error, additionalInfo);
  }
};

async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

// ============================================
// NotebookLM API Client (inline)
// ============================================

const NotebookLMAPI = {
  BASE_URL: 'https://notebooklm.google.com',
  tokens: null,
  TOKEN_LIFETIME_MS: 30 * 60 * 1000, // 30 minutes

  // Get authentication tokens from NotebookLM page
  async getTokens(authuser = 0, forceRefresh = false) {
    try {
      // Check if tokens are still valid (not expired)
      if (!forceRefresh && this.tokens && this.tokens.timestamp) {
        const tokenAge = Date.now() - this.tokens.timestamp;
        if (tokenAge < this.TOKEN_LIFETIME_MS) {
          return this.tokens; // Tokens are still fresh
        }
        console.log('Tokens expired, refreshing...');
      }

      const url = authuser > 0
        ? `${this.BASE_URL}/?authuser=${authuser}&pageId=none`
        : this.BASE_URL;

      // Use rate limiter to prevent excessive token refresh requests
      const response = await RateLimiter.throttle(async () => {
        return await fetchWithTimeout(url, {
          credentials: 'include',
          redirect: 'manual'
        });
      });

      // Validate response origin for security
      if (response.url) {
        ResponseValidator.validateOrigin(response.url, 'notebooklm.google.com');
      }

      if (!response.ok && response.type !== 'opaqueredirect') {
        throw new Error('Failed to fetch NotebookLM page');
      }

      const html = await response.text();

      // Validate HTML response
      if (!html || typeof html !== 'string' || html.length < 100) {
        throw new Error('Invalid HTML response from NotebookLM');
      }

      // Extract tokens from HTML
      const bl = this.extractToken('cfb2h', html);
      const at = this.extractToken('SNlM0e', html);

      if (!bl || !at) {
        ErrorHandler.logError('getTokens', new Error('Tokens not found in HTML'), {
          htmlLength: html.length,
          authuser
        });
        throw new Error('Not authorized. Please login to NotebookLM first.');
      }

      // Store tokens with timestamp
      this.tokens = {
        bl,
        at,
        authuser,
        timestamp: Date.now()
      };

      console.log('Tokens refreshed successfully');
      return this.tokens;
    } catch (error) {
      ErrorHandler.logError('getTokens', error);

      // Clear invalid tokens
      this.tokens = null;

      throw new Error(ErrorHandler.getUserFriendlyMessage(error));
    }
  },

  // Extract token from HTML using regex
  extractToken(key, html) {
    const regex = new RegExp(`"${key}":"([^"]+)"`);
    const match = regex.exec(html);
    return match ? match[1] : null;
  },

  // List all notebooks
  async listNotebooks() {
    const response = await this.rpc('wXbhsf', [null, 1, null, [2]]);
    return this.parseNotebookList(response);
  },

  // Parse notebook list from RPC response
  parseNotebookList(responseText) {
    try {
      // Response format: )]}'\n\nXX[[["wrb.fr","wXbhsf","[...]",...
      const lines = responseText.split('\n');
      const dataLine = lines.find(line => line.includes('wrb.fr'));
      if (!dataLine) return [];

      // Parse the nested JSON
      const parsed = JSON.parse(dataLine);
      const innerData = JSON.parse(parsed[0][2]);

      if (!innerData || !innerData[0]) return [];

      return innerData[0]
        .filter(item => item && item.length >= 3)
        .filter(item => {
          // Filter out shared notebooks (type 3)
          const metadata = item[5];
          return !(Array.isArray(metadata) && metadata.length > 0 && metadata[0] === 3);
        })
        .map(item => ({
          id: item[2],
          name: item[0]?.trim() || 'Untitled notebook',
          sources: item[1]?.length || 0,
          emoji: item[3] || '📔'
        }));
    } catch (error) {
      console.error('parseNotebookList error:', error);
      return [];
    }
  },

  // Create a new notebook
  async createNotebook(title, emoji = '📔') {
    const response = await this.rpc('CCqFvf', [title]);

    // Extract notebook ID from response
    const uuidMatch = response.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (!uuidMatch) {
      throw new Error('Failed to create notebook');
    }

    return { id: uuidMatch[0], name: title, emoji };
  },

  // Add a single source to notebook
  async addSource(notebookId, url) {
    return this.addSources(notebookId, [url]);
  },

  // Add multiple sources to notebook
  async addSources(notebookId, urls) {
    // Validate notebook ID
    ResponseValidator.validateNotebookId(notebookId);

    // Validate all URLs
    urls.forEach(url => ResponseValidator.validateUrl(url));

    const sources = urls.map(url => {
      // YouTube URLs need special format
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        return [null, null, null, null, null, null, null, [url]];
      }
      // Regular URLs
      return [null, null, [url]];
    });

    const response = await this.rpc('izAoDd', [sources, notebookId], `/notebook/${notebookId}`);
    return response;
  },

  // Add text content as source
  async addTextSource(notebookId, text, title = 'Imported content') {
    const source = [[null, [title, text], null, null, null, null, null, null]];
    const response = await this.rpc('izAoDd', [source, notebookId, [2], null, null], `/notebook/${notebookId}`);
    return response;
  },

  // Check notebook status (sources loading)
  async getNotebookStatus(notebookId) {
    const response = await this.rpc('rLM1Ne', [notebookId, null, [2]], `/notebook/${notebookId}`);
    // Check if notebook ID appears in response (means sources are loaded)
    return !response.includes(`null,\\"${notebookId}`);
  },

  // Wait for sources to be added
  async waitForSources(notebookId, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      const ready = await this.getNotebookStatus(notebookId);
      if (ready) return true;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
  },

  // Execute RPC call to NotebookLM
  async rpc(rpcId, params, sourcePath = '/') {
    // Check if tokens exist and are not expired
    if (!this.tokens || !this.tokens.timestamp) {
      await this.getTokens();
    } else {
      const tokenAge = Date.now() - this.tokens.timestamp;
      if (tokenAge > this.TOKEN_LIFETIME_MS) {
        console.log('Tokens expired, refreshing before RPC call...');
        await this.getTokens(this.tokens.authuser, true);
      }
    }

    const url = new URL(`${this.BASE_URL}/_/LabsTailwindUi/data/batchexecute`);
    const reqId = Math.floor(Math.random() * 900000 + 100000).toString();

    url.searchParams.set('rpcids', rpcId);
    url.searchParams.set('source-path', sourcePath);
    url.searchParams.set('bl', this.tokens.bl);
    url.searchParams.set('_reqid', reqId);
    url.searchParams.set('rt', 'c');

    if (this.tokens.authuser > 0) {
      url.searchParams.set('authuser', this.tokens.authuser);
    }

    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(params), null, 'generic']]]),
      'at': this.tokens.at
    });

    // Use rate limiter for API calls
    const response = await RateLimiter.throttle(async () => {
      return await fetchWithTimeout(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        credentials: 'include',
        body: body.toString()
      });
    });

    if (!response.ok) {
      throw new Error(`RPC call failed: ${response.status}`);
    }

    const responseText = await response.text();

    // Validate response
    ResponseValidator.validateRpcResponse(responseText);

    return responseText;
  },

  // Get list of Google accounts (filter out YouTube channels/profiles)
  async listAccounts() {
    try {
      const response = await fetchWithTimeout(
        'https://accounts.google.com/ListAccounts?json=standard&source=ogb&md=1&cc=1&mn=1&mo=1&gpsia=1&fwput=860&listPages=1&origin=https%3A%2F%2Fwww.google.com',
        { credentials: 'include' }
      );

      const text = await response.text();

      // Extract JSON from postMessage call
      const match = text.match(/postMessage\('([^']*)'\s*,\s*'https:/);
      if (!match) return [];

      // Decode escaped characters
      const decoded = match[1]
        .replace(/\\x5b/g, '[')
        .replace(/\\x5d/g, ']')
        .replace(/\\x22/g, '"');

      const parsed = JSON.parse(decoded);
      const accounts = parsed[1] || [];

      // Filter: only keep entries with valid email addresses (real Google accounts)
      // YouTube channels/profiles don't have email in acc[3]
      return accounts
        .filter(acc => acc[3] && acc[3].includes('@'))
        .map((acc, idx) => ({
          name: acc[2] || null,
          email: acc[3] || null,
          avatar: acc[4] || null,
          isActive: acc[5] || false,
          isDefault: acc[6] || false,
          index: idx  // Use filtered index for authuser param
        }));
    } catch (error) {
      console.error('listAccounts error:', error);
      return [];
    }
  },

  // Get notebook URL
  getNotebookUrl(notebookId, authuser = 0) {
    const base = `${this.BASE_URL}/notebook/${notebookId}`;
    return authuser > 0 ? `${base}?authuser=${authuser}` : base;
  },

  // Get notebook details with sources list
  async getNotebook(notebookId) {
    const response = await this.rpc('rLM1Ne', [notebookId, null, [2], null, 0], `/notebook/${notebookId}`);
    return this.parseNotebookDetails(response);
  },

  // Parse notebook details from RPC response
  parseNotebookDetails(responseText) {
    try {
      const lines = responseText.split('\n');
      const dataLine = lines.find(line => line.includes('wrb.fr'));
      if (!dataLine) return { sources: [] };

      const parsed = JSON.parse(dataLine);
      const innerData = JSON.parse(parsed[0][2]);

      if (!innerData || !innerData[0]) return { sources: [] };

      const notebookData = innerData[0];
      const sourcesArray = notebookData[3] || [];

      const sources = sourcesArray
        .filter(source => source && source[0])
        .map(source => {
          const sourceType = source[3]?.[0] || 0;
          const typeNames = {
            1: 'url',
            3: 'text',
            4: 'youtube',
            7: 'pdf',
            8: 'audio'
          };

          return {
            id: source[0],
            title: source[2] || 'Untitled',
            type: typeNames[sourceType] || 'unknown',
            typeCode: sourceType,
            url: source[3]?.[1] || null,
            status: source[4] || 0
          };
        });

      return {
        id: notebookData[0],
        title: notebookData[1],
        sources
      };
    } catch (error) {
      console.error('parseNotebookDetails error:', error);
      return { sources: [] };
    }
  },

  // Delete a single source from notebook
  async deleteSource(notebookId, sourceId) {
    // Validate IDs
    ResponseValidator.validateNotebookId(notebookId);
    ResponseValidator.validateNotebookId(sourceId); // Source ID is also UUID

    // Note: notebook_id is passed via source_path, NOT in params!
    // Payload structure: [[[source_id]]] (triple-nested)
    const response = await this.rpc('tGMBJ', [[[sourceId]]], `/notebook/${notebookId}`);
    return response;
  },

  // Delete multiple sources from notebook (batch operation)
  // API supports max ~20 sources per request, so we chunk into batches
  async deleteSources(notebookId, sourceIds) {
    // Validate notebook ID
    ResponseValidator.validateNotebookId(notebookId);

    // Validate all source IDs
    sourceIds.forEach(id => ResponseValidator.validateNotebookId(id));

    if (sourceIds.length === 0) {
      return { success: true, deletedCount: 0 };
    }

    const BATCH_SIZE = 20;
    let deletedCount = 0;

    // Split into chunks of BATCH_SIZE
    for (let i = 0; i < sourceIds.length; i += BATCH_SIZE) {
      const batch = sourceIds.slice(i, i + BATCH_SIZE);

      // Batch delete: payload format is [[[id1], [id2], [id3]...]]
      const batchPayload = [batch.map(id => [id])];
      await this.rpc('tGMBJ', batchPayload, `/notebook/${notebookId}`);

      deletedCount += batch.length;
    }

    return { success: true, deletedCount };
  }
};

// ============================================
// Background Service Worker Logic
// ============================================

// Store for current state
let currentAuthuser = 0;

// YouTube comments parse state
let parseState = {
  active: false,
  videoId: null,
  progress: { fetched: 0, total: null, phase: 'idle' },
  cancelToken: null,
  error: null,
  result: null
};

// Initialize on install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Initialize storage
    chrome.storage.sync.set({
      selectedAccount: 0,
      lastNotebook: null,
      autoOpenNotebook: false
    });
  }

  // Clean up old API key setting (no longer needed)
  chrome.storage.local.remove('youtubeApiKey');

  // Setup context menus
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'send-to-notebooklm',
      title: '📔 Send to NotebookLM',
      contexts: ['page', 'link']
    });
  });
});

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch(error => {
      console.error('Message handler error:', error);
      sendResponse({ error: error.message });
    });

  // Return true to indicate async response
  return true;
});

// Main message handler
async function handleMessage(request, sender) {
  const { cmd, ...params } = request;

  // Get selected account from storage
  // Support both storage key formats
  const storage = await chrome.storage.sync.get(['selectedAccount', 'selected_account']);
  currentAuthuser = storage.selectedAccount || storage.selected_account || 0;

  // Commands that don't require tokens
  const noTokenCommands = ['list-accounts', 'ping', 'get-current-tab', 'get-all-tabs', 'get-parse-status', 'cancel-parse'];

  // Ensure we have tokens for API calls
  if (!noTokenCommands.includes(cmd)) {
    try {
      await NotebookLMAPI.getTokens(currentAuthuser);
    } catch (error) {
      return { error: 'Please login to NotebookLM first', err: 'Please authorize NotebookLM to continue' };
    }
  }

  switch (cmd) {
    case 'ping':
      return { ok: true };

    case 'list-accounts':
      return await listAccounts();

    case 'list-notebooks':
      return await listNotebooks();

    // Legacy command support
    case 'list-notebooklm':
      return await listNotebooksLegacy();

    case 'create-notebook':
      return await createNotebook(params.title, params.emoji);

    case 'add-source':
      return await addSource(params.notebookId, params.url);

    case 'add-sources':
      return await addSources(params.notebookId, params.urls);

    case 'add-text-source':
      return await addTextSource(params.notebookId, params.text, params.title);

    case 'get-current-tab':
      return await getCurrentTab();

    case 'get-all-tabs':
      return await getAllTabs();

    case 'save-to-notebook':
      return await saveToNotebook(params);

    case 'save-to-notebooklm':
      return await saveToNotebookLMOriginal(params.title, params.urls, params.currentURL, params.notebookID);

    case 'get-notebook':
      return await getNotebook(params.notebookId);

    case 'get-sources':
      return await getSources(params.notebookId);

    case 'delete-source':
      return await deleteSource(params.notebookId, params.sourceId);

    case 'delete-sources':
      return await deleteSources(params.notebookId, params.sourceIds);

    case 'get-parse-status':
      return {
        active: parseState.active,
        videoId: parseState.videoId,
        progress: parseState.progress,
        error: parseState.error,
        result: parseState.result
      };

    case 'cancel-parse':
      if (parseState.cancelToken) {
        parseState.cancelToken.cancelled = true;
        parseState.progress.phase = 'cancelled';
        parseState.active = false;
      }
      return { success: true };

    case 'parse-comments':
      if (parseState.active) {
        return { error: 'Parse already in progress' };
      }
      doParseComments(params.notebookId, params.videoId, params.tabId);
      return { started: true };

    default:
      console.log('Unknown command:', cmd);
      return { error: `Unknown command: ${cmd}` };
  }
}

// List Google accounts
async function listAccounts() {
  try {
    const accounts = await NotebookLMAPI.listAccounts();
    // Return both formats for compatibility
    return { accounts, list: accounts };
  } catch (error) {
    ErrorHandler.logError('listAccounts', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error), accounts: [], list: [] };
  }
}

// List notebooks
async function listNotebooks() {
  try {
    const notebooks = await NotebookLMAPI.listNotebooks();
    return { notebooks };
  } catch (error) {
    ErrorHandler.logError('listNotebooks', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error), notebooks: [] };
  }
}

// List notebooks in legacy format
async function listNotebooksLegacy() {
  try {
    const notebooks = await NotebookLMAPI.listNotebooks();
    return { list: notebooks };
  } catch (error) {
    ErrorHandler.logError('listNotebooksLegacy', error);
    return { err: ErrorHandler.getUserFriendlyMessage(error), list: [] };
  }
}

// Create new notebook
async function createNotebook(title, emoji = '📔') {
  try {
    const notebook = await NotebookLMAPI.createNotebook(title, emoji);
    return { notebook };
  } catch (error) {
    ErrorHandler.logError('createNotebook', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error) };
  }
}

// Add single source
async function addSource(notebookId, url) {
  try {
    await NotebookLMAPI.addSource(notebookId, url);
    return { success: true };
  } catch (error) {
    ErrorHandler.logError('addSource', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error) };
  }
}

// Add multiple sources
async function addSources(notebookId, urls) {
  try {
    await NotebookLMAPI.addSources(notebookId, urls);

    // Wait for sources to be processed
    await NotebookLMAPI.waitForSources(notebookId);

    return {
      success: true,
      notebookUrl: NotebookLMAPI.getNotebookUrl(notebookId, currentAuthuser)
    };
  } catch (error) {
    ErrorHandler.logError('addSources', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error) };
  }
}

// Add text content as source
async function addTextSource(notebookId, text, title) {
  try {
    await NotebookLMAPI.addTextSource(notebookId, text, title);
    return { success: true };
  } catch (error) {
    ErrorHandler.logError('addTextSource', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error) };
  }
}

// Get notebook details with sources
async function getNotebook(notebookId) {
  try {
    const notebook = await NotebookLMAPI.getNotebook(notebookId);
    return { notebook };
  } catch (error) {
    ErrorHandler.logError('getNotebook', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error) };
  }
}

// Get sources list for a notebook
async function getSources(notebookId) {
  try {
    const notebook = await NotebookLMAPI.getNotebook(notebookId);
    return { sources: notebook.sources || [] };
  } catch (error) {
    ErrorHandler.logError('getSources', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error), sources: [] };
  }
}

// Delete single source
async function deleteSource(notebookId, sourceId) {
  try {
    await NotebookLMAPI.deleteSource(notebookId, sourceId);
    return { success: true };
  } catch (error) {
    ErrorHandler.logError('deleteSource', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error) };
  }
}

// Delete multiple sources (batch)
async function deleteSources(notebookId, sourceIds) {
  try {
    const result = await NotebookLMAPI.deleteSources(notebookId, sourceIds);
    return {
      success: true,
      successCount: result.deletedCount || sourceIds.length,
      failCount: 0
    };
  } catch (error) {
    ErrorHandler.logError('deleteSources', error);
    return { error: ErrorHandler.getUserFriendlyMessage(error) };
  }
}

// Get current active tab
async function getCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return {
      tab: {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        favIconUrl: tab.favIconUrl
      }
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Get all open tabs
async function getAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    return {
      tabs: tabs
        .filter(tab => tab.url && tab.url.startsWith('http'))
        .map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          favIconUrl: tab.favIconUrl,
          windowId: tab.windowId
        }))
    };
  } catch (error) {
    return { error: error.message, tabs: [] };
  }
}

// Save URL(s) to notebook (main workflow)
async function saveToNotebook({ title, urls, notebookId, createNew }) {
  try {
    let targetNotebookId = notebookId;

    // Create new notebook if requested
    if (createNew || !notebookId) {
      const emoji = urls.some(url => url.includes('youtube.com')) ? '📺' : '📔';
      const result = await NotebookLMAPI.createNotebook(title || 'Imported content', emoji);
      targetNotebookId = result.id;
    }

    // Add sources
    await NotebookLMAPI.addSources(targetNotebookId, urls);

    // Wait for sources to be processed
    await NotebookLMAPI.waitForSources(targetNotebookId);

    // Get settings
    const settings = await chrome.storage.sync.get(['autoOpenNotebook']);

    // Open notebook if setting enabled
    if (settings.autoOpenNotebook) {
      const notebookUrl = NotebookLMAPI.getNotebookUrl(targetNotebookId, currentAuthuser);
      chrome.tabs.create({ url: notebookUrl });
    }

    return {
      success: true,
      notebookId: targetNotebookId,
      notebookUrl: NotebookLMAPI.getNotebookUrl(targetNotebookId, currentAuthuser)
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Save to NotebookLM (legacy format)
async function saveToNotebookLMOriginal(title, urls, currentURL, notebookID) {
  try {
    // Set progress indicator in local storage
    if (currentURL) {
      await chrome.storage.local.set({ [currentURL]: { label: 'Creating Notebook...' } });
    }

    let targetNotebookId = notebookID;

    // Create new notebook if no ID provided
    if (!notebookID) {
      const result = await NotebookLMAPI.createNotebook(title || 'YouTube Videos', '📺');
      targetNotebookId = result.id;
    }

    // Update progress
    if (currentURL) {
      await chrome.storage.local.set({ [currentURL]: { label: 'Adding sources...' } });
    }

    // Add sources
    await NotebookLMAPI.addSources(targetNotebookId, urls);

    // Wait for sources to be processed
    await NotebookLMAPI.waitForSources(targetNotebookId);

    // Clear progress indicators
    if (currentURL) {
      await chrome.storage.local.remove([currentURL, 'ytLinks']);
    }

    // Build authuser param for URL
    const authParam = currentAuthuser > 0 ? `?authuser=${currentAuthuser}` : '';

    return {
      url: `https://notebooklm.google.com/notebook/${targetNotebookId}${authParam}`
    };
  } catch (error) {
    return { err: error.message };
  }
}

// Fire-and-forget: fetch comments, format, send to NotebookLM
async function doParseComments(notebookId, videoId, tabId) {
  const cancelToken = { cancelled: false };
  parseState = {
    active: true,
    videoId,
    progress: { fetched: 0, total: null, phase: 'fetching' },
    cancelToken,
    error: null,
    result: null
  };

  try {
    // Phase 1: Fetch metadata from DOM (no API key needed)
    const metadata = await YouTubeCommentsAPI.getVideoMetadataFromDOM(tabId);
    parseState.progress.total = metadata.commentCount;

    if (cancelToken.cancelled) return;

    // Load comments settings
    const settings = await chrome.storage.local.get(['commentsMode', 'commentsLimit', 'commentsIncludeReplies']);
    const mode = settings.commentsMode || 'top';
    const includeReplies = settings.commentsIncludeReplies !== undefined ? settings.commentsIncludeReplies : (mode === 'top');
    // For 'top' mode: maxComments=0 (YouTube limits naturally to ~1000)
    // For 'newest' mode: use configured limit
    const maxComments = mode === 'top' ? 0 : (settings.commentsLimit || 1000);

    // Phase 2: Fetch comments via InnerTube API
    const comments = await YouTubeCommentsAPI.fetchAllComments(videoId, {
      progressCallback: ({ fetched, phase }) => {
        parseState.progress.fetched = fetched;
        if (phase === 'fetching_replies') {
          parseState.progress.phase = 'fetching_replies';
        }
      },
      cancelToken,
      tabId,
      mode,
      maxComments,
      includeReplies
    });

    if (cancelToken.cancelled) return;

    // Phase 3: Format to MD
    parseState.progress.phase = 'formatting';
    const storage = await chrome.storage.sync.get(['language']);
    const lang = storage.language || 'en';
    const parts = CommentsToMd.format(metadata, comments, { lang });

    if (cancelToken.cancelled) return;

    // Phase 4: Send to NotebookLM
    parseState.progress.phase = 'sending';
    // Refresh tokens before sending (parsing may have taken minutes)
    await NotebookLMAPI.getTokens(currentAuthuser);
    for (let i = 0; i < parts.length; i++) {
      if (cancelToken.cancelled) return;
      await NotebookLMAPI.addTextSource(notebookId, parts[i].text, parts[i].title);
    }

    // Done
    parseState.progress.phase = 'done';
    parseState.result = {
      commentCount: comments.length,
      totalComments: metadata.commentCount,
      partCount: parts.length,
      videoTitle: metadata.title
    };
  } catch (e) {
    console.error('doParseComments error:', e);
    parseState.progress.phase = 'error';
    parseState.error = { code: e.code || 'UNKNOWN', message: e.message };
  } finally {
    parseState.active = false;
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'send-to-notebooklm') {
    const url = info.linkUrl || info.pageUrl;

    // Store the URL and open bulk import page
    await chrome.storage.local.set({
      pendingUrl: url,
      pendingTitle: tab.title
    });

    chrome.tabs.create({
      url: chrome.runtime.getURL(`app/app.html?url=${encodeURIComponent(url)}`)
    });
  }
});

console.log('Add to NotebookLM: Background service worker started');
