const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const url = require('node:url');

const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = path.join(APP_DATA_DIR, 'brain');

function getDataDir() {
  const envDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (envDir) return envDir;
  const target = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'session-stats', 'viewer', 'data');
  try {
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch {
    const tmp = path.join(os.tmpdir(), 'gemini', 'antigravity', 'sidecar_data', 'session-stats', 'viewer', 'data');
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

function findLatestConversation() {
  try {
    if (!fs.existsSync(BRAIN_DIR)) return null;
    const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
    let best = null;
    let bestMtime = 0;

    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const tPath = path.join(BRAIN_DIR, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(tPath)) {
        const stat = fs.statSync(tPath);
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = ent.name;
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

function listConversations() {
  try {
    if (!fs.existsSync(BRAIN_DIR)) return [];
    const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
    const list = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const tPath = path.join(BRAIN_DIR, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(tPath)) {
        const stat = fs.statSync(tPath);
        list.push({ id: ent.name, mtimeMs: stat.mtimeMs, updated: stat.mtime });
      }
    }
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return list.slice(0, 15);
  } catch {
    return [];
  }
}

function parseTranscript(convId) {
  if (!convId) return null;
  const tPath = path.join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(tPath)) return null;

  try {
    const content = fs.readFileSync(tPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    let totalInput = 0;
    let totalCached = 0;
    let totalOutput = 0;
    let turnCount = 0;
    let stepCount = lines.length;
    let totalLlmTimeMs = 0;
    let totalToolTimeMs = 0;
    let lastPlanner = null;

    for (let i = 0; i < lines.length; i++) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.type === 'PLANNER_RESPONSE') {
          turnCount++;
          lastPlanner = item;
          if (typeof item.input_tokens === 'number') totalInput += item.input_tokens;
          if (typeof item.cache_read_tokens === 'number') totalCached += item.cache_read_tokens;
          if (typeof item.output_tokens === 'number') totalOutput += item.output_tokens;
        }

        if (i > 0) {
          const prev = JSON.parse(lines[i - 1]);
          const prevT = new Date(prev.created_at).getTime();
          const currT = new Date(item.created_at).getTime();
          const diff = Math.max(0, currT - prevT);

          if (item.type === 'PLANNER_RESPONSE') {
            totalLlmTimeMs += diff;
          } else if (prev.type === 'PLANNER_RESPONSE' && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) {
            totalToolTimeMs += diff;
          }
        }
      } catch {}
    }

    const totalTokens = totalInput + totalCached + totalOutput;
    const cacheHitPct = (totalInput + totalCached) > 0 ? ((totalCached / (totalInput + totalCached)) * 100) : 0;
    const activeContext = lastPlanner ? ((lastPlanner.input_tokens || 0) + (lastPlanner.cache_read_tokens || 0)) : 0;
    const contextLimit = 1000000;
    const contextPct = ((activeContext / contextLimit) * 100);

    const systemPromptEst = activeContext > 0 ? Math.min(activeContext, 1400) : 0;
    const toolDefsEst = activeContext > systemPromptEst ? Math.min(activeContext - systemPromptEst, 7400) : 0;
    const messagesEst = Math.max(0, activeContext - systemPromptEst - toolDefsEst);

    const llmSec = totalLlmTimeMs / 1000;
    const toolSec = totalToolTimeMs / 1000;
    const tps = llmSec > 0 ? Math.round(totalOutput / llmSec) : 0;
    const avgTtft = turnCount > 0 ? (llmSec / turnCount).toFixed(1) : '1.0';

    return {
      conversationId: convId,
      stepCount,
      turnCount,
      totalTokens,
      tokens: {
        total: totalTokens,
        cacheHitRate: Math.round(cacheHitPct),
        uncachedInput: totalInput,
        cachedInput: totalCached,
        output: totalOutput
      },
      timings: {
        llmTimeSec: llmSec < 60 ? `${llmSec.toFixed(1)}s` : `${Math.floor(llmSec / 60)}m ${(llmSec % 60).toFixed(0)}s`,
        toolTimeSec: toolSec < 60 ? `${toolSec.toFixed(1)}s` : `${Math.floor(toolSec / 60)}m ${(toolSec % 60).toFixed(0)}s`,
        avgTtft: `${avgTtft}s`,
        tps: `${tps} tok/s`
      },
      context: {
        activeTokens: activeContext,
        maxTokens: contextLimit,
        percentUsed: contextPct < 1 && activeContext > 0 ? '< 1%' : `${Math.round(contextPct)}%`,
        percentNum: contextPct,
        breakdown: {
          systemPrompt: systemPromptEst,
          toolDefinitions: toolDefsEst,
          messages: messagesEst
        }
      }
    };
  } catch (err) {
    return { error: err.message };
  }
}

const reqPort = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10);
const uiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN || null;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${reqPort || 8000}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/' || pathname === '/ui.html') {
    const htmlPath = path.join(__dirname, 'ui.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error loading ui.html: ${err.message}`);
    }
    return;
  }

  if (pathname === '/preload.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end('// Antigravity Sidecar Bridge\nwindow.__sidecarReady = true;\n');
    return;
  }

  if (pathname === '/api/stats') {
    let convId = parsedUrl.searchParams.get('conversationId')?.trim();
    if (!convId || convId === 'current') {
      convId = findLatestConversation();
    }
    const stats = parseTranscript(convId);
    if (!stats) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Conversation ${convId} not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(stats));
    return;
  }

  if (pathname === '/api/conversations') {
    const list = listConversations();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ conversations: list }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const dataDir = getDataDir();
const serverInfoPath = path.join(dataDir, 'server_info.json');

function cleanup() {
  try {
    if (fs.existsSync(serverInfoPath)) {
      fs.rmSync(serverInfoPath, { force: true });
    }
  } catch {}
}

server.listen(reqPort, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log(`[SessionStatsSidecar] Listening on http://127.0.0.1:${actualPort}`);

  try {
    const info = {
      host: '127.0.0.1',
      port: actualPort,
      token: uiToken,
      pid: process.pid
    };
    fs.writeFileSync(serverInfoPath, JSON.stringify(info, null, 2), 'utf8');
  } catch (err) {
    console.error(`[SessionStatsSidecar] Failed to write server_info.json: ${err.message}`);
  }
});

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', () => { cleanup(); });
