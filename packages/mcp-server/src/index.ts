#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { config } from './config.js';

import { spawn, ChildProcess } from 'child_process';

import * as net from 'net';

import { fileURLToPath } from 'url';

import * as os from 'os';

import * as fs from 'fs';

import * as path from 'path';

const CONTROL_HOST = '127.0.0.1';

const CONTROL_PORT = 31414;

// How long a wrapper keeps trying to reach a backend before giving up. Claude Desktop
// starts several wrappers at once, so a backend started by another wrapper may still be
// booting when we first try to connect.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

const MAX_RETRY_DELAY_MS = 1_000;

// Minimum gap between spawn attempts while no backend is reachable.
const RESPAWN_INTERVAL_MS = 2_000;

// Same path as LOCK_FILE in backend.ts
const BACKEND_LOCK_FILE = path.join(os.tmpdir(), 'foundry-mcp-backend.lock');

// True when the backend lock names a live process, i.e. a backend is running or still booting
function isBackendLockHeld(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(BACKEND_LOCK_FILE, 'utf8').trim(), 10);

    if (!pid) return false;

    process.kill(pid, 0);

    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else
    return (e as any)?.code === 'EPERM';
  }
}

function getConnectTimeoutMs(): number {
  const raw = Number(process.env.FOUNDRY_MCP_CONNECT_TIMEOUT_MS);

  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONNECT_TIMEOUT_MS;
}

type BackendReq = { id: string; method: string; params?: any };

type BackendRes = { id: string; result?: any; error?: { message: string } };

class BackendClient {
  private socket: net.Socket | null = null;

  private buffer = '';

  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();

  private logFile = path.join(os.tmpdir(), 'foundry-mcp-server', 'wrapper.log');

  private backendProcess: ChildProcess | null = null;

  private connecting: Promise<void> | null = null;

  private log(msg: string, meta?: any) {
    try {
      const dir = path.dirname(this.logFile);

      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const line = `[${new Date().toISOString()}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;

      fs.appendFileSync(this.logFile, line);
    } catch {}
  }

  async ensure(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    // Share one connection attempt between concurrent callers
    if (!this.connecting) {
      this.log('ensure(): connecting to backend');

      this.connecting = this.connectWithRetry().finally(() => {
        this.connecting = null;
      });
    }

    await this.connecting;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: CONTROL_HOST, port: CONTROL_PORT }, () => {
        this.socket = sock;

        sock.setEncoding('utf8');

        sock.on('data', (chunk: string) => this.onData(chunk));

        sock.on('error', err => this.rejectAll(err));

        sock.on('close', () => this.rejectAll(new Error('Backend disconnected')));

        this.log('connect(): connected to backend');

        resolve();
      });

      sock.on('error', e => {
        this.log('connect(): error', { error: (e as any)?.message });
        reject(e);
      });
    });
  }

  private async connectWithRetry(): Promise<void> {
    const timeoutMs = getConnectTimeoutMs();

    const startedAt = Date.now();

    const deadline = startedAt + timeoutMs;

    let lastSpawnAt = 0;

    let lastError: unknown;

    for (let attempt = 0; ; attempt++) {
      try {
        await this.connect();

        if (attempt > 0) {
          this.log('connectWithRetry(): connected', {
            attempts: attempt + 1,
            elapsedMs: Date.now() - startedAt,
          });
        }

        return;
      } catch (error) {
        lastError = error;
      }

      // Nothing is listening yet. Start a backend unless ours is still booting or another
      // backend holds the lock (it is still booting, so keep waiting for it). If we lose the
      // lock race our backend exits cleanly; if the lock holder dies, a later pass replaces it.
      if (
        !this.backendProcess &&
        Date.now() - lastSpawnAt >= RESPAWN_INTERVAL_MS &&
        (lastSpawnAt === 0 || !isBackendLockHeld())
      ) {
        lastSpawnAt = Date.now();

        this.log('connectWithRetry(): starting backend');

        this.startBackend();
      }

      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) break;

      const delayMs = Math.min(100 * Math.pow(1.5, attempt), MAX_RETRY_DELAY_MS, remainingMs);

      this.log('connectWithRetry(): retry failed', {
        attempt: attempt + 1,
        delayMs: Math.round(delayMs),
        error: (lastError as any)?.message,
      });

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const errorMessage = lastError instanceof Error ? lastError.message : 'Unknown error';

    const message =
      `Foundry MCP wrapper: no backend accepted a connection on ${CONTROL_HOST}:${CONTROL_PORT} ` +
      `within ${timeoutMs}ms (last error: ${errorMessage}). ` +
      `Set FOUNDRY_MCP_CONNECT_TIMEOUT_MS to wait longer.`;

    this.log('connectWithRetry(): giving up', { timeoutMs, error: errorMessage });

    console.error(message);

    throw new Error(message);
  }

  private startBackend(): void {
    let backendPath: string;

    try {
      const backendUrl = new URL('./backend.js', import.meta.url as any);

      backendPath = fileURLToPath(backendUrl);
    } catch {
      const baseDir =
        typeof __dirname !== 'undefined'
          ? __dirname
          : path.dirname((process.argv && process.argv[1]) || process.cwd());

      // Prefer bundled backend when present (contains deps), fallback to ESM

      const bundleCandidate = path.join(baseDir, 'backend.bundle.cjs');

      const jsCandidate = path.join(baseDir, 'backend.js');

      backendPath = fs.existsSync(bundleCandidate) ? bundleCandidate : jsCandidate;
    }

    const nodePath = process.execPath;

    const child = spawn(nodePath, [backendPath], {
      detached: false, // Stay attached to monitor backend

      stdio: ['ignore', 'ignore', 'pipe'], // Capture stderr to detect exit
    });

    this.log('startBackend(): spawned', { node: nodePath, path: backendPath, pid: child.pid });

    // Store reference for cleanup

    this.backendProcess = child;

    child.on('error', err => {
      this.log('startBackend(): spawn error', { error: err.message });
    });

    child.on('exit', code => {
      if (this.backendProcess === child) this.backendProcess = null;

      if (code === 0) {
        // The backend exits cleanly when another backend already holds the lock. That
        // backend may still be booting, so connectWithRetry() keeps waiting for it.
        this.log('startBackend(): backend exited cleanly (lock held by another backend)', {
          pid: child.pid,
        });
      } else if (code !== null) {
        this.log('startBackend(): backend exited unexpectedly', { pid: child.pid, exitCode: code });
      }
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;

    let idx: number;

    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();

      this.buffer = this.buffer.slice(idx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as BackendRes;

        this.log('onData(): received response', {
          id: msg.id,
          hasError: !!msg.error,
          hasResult: !!msg.result,
        });

        const p = this.pending.get(msg.id);

        if (!p) {
          this.log('onData(): no pending request found', { id: msg.id });
          continue;
        }

        this.pending.delete(msg.id);

        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } catch (e) {
        this.log('onData(): JSON parse error', {
          error: (e as any)?.message,
          lineLength: line.length,
        });
      }
    }
  }

  private rejectAll(err: any) {
    for (const [, p] of this.pending) p.reject(err);

    this.pending.clear();

    this.socket = null;
  }

  send(method: string, params: any): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.ensure();
      } catch (e) {
        this.log('send(): ensure failed', { error: (e as any)?.message });

        return reject(e);
      }

      const id = Math.random().toString(36).slice(2);

      const req: BackendReq = { id, method, params };

      this.pending.set(id, { resolve, reject });

      try {
        this.log('send(): write', { method });

        this.socket!.write(JSON.stringify(req) + '\n', 'utf8');
      } catch (e) {
        this.pending.delete(id);

        this.log('send(): write error', { error: (e as any)?.message });

        reject(e);
      }
    });
  }

  cleanup() {
    this.log('cleanup(): shutting down backend');

    if (this.backendProcess && !this.backendProcess.killed) {
      try {
        // Kill backend process - works cross-platform

        this.backendProcess.kill();

        this.log('cleanup(): backend process killed');
      } catch (e) {
        this.log('cleanup(): error killing backend', { error: (e as any)?.message });
      }
    }

    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

async function startWrapper() {
  const backend = new BackendClient();

  // Handle termination signals first: the pre-connect below can wait for a backend that
  // this wrapper spawned, and that backend must still be cleaned up if we are killed

  process.on('SIGTERM', () => {
    backend.cleanup();

    process.exit(0);
  });

  process.on('SIGINT', () => {
    backend.cleanup();

    process.exit(0);
  });

  // Pre-connect to backend BEFORE initializing MCP server. stdin is not read until the
  // transport starts, so initialize and tools/list are answered only once the backend is
  // reachable (or the connect deadline has passed)
  try {
    await backend.ensure();
    try {
      (backend as any).log?.('startWrapper(): pre-connected to backend');
    } catch {}
  } catch (e) {
    try {
      (backend as any).log?.('startWrapper(): pre-connection failed, will retry on demand', {
        error: (e as any)?.message,
      });
    } catch {}
  }

  const mcp = new Server(
    { name: config.server.name, version: config.server.version },
    { capabilities: { tools: {} } }
  );

  // Setup cleanup handlers - cross-platform approach

  // When stdin closes (Claude Desktop exits), clean up the backend

  process.stdin.on('end', () => {
    backend.cleanup();

    process.exit(0);
  });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const res = await backend.send('list_tools', {});

      try {
        (backend as any).log?.('ListTools handler: received from backend', {
          hasTools: !!res.tools,
          toolCount: res.tools?.length || 0,
        });
      } catch {}

      return { tools: res.tools || [] };
    } catch (e) {
      // Log but return empty to remain MCP-compliant

      try {
        (backend as any).log?.('ListTools failed; returning empty', { error: (e as any)?.message });
      } catch {}

      return { tools: [] };
    }
  });

  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params as any;

    try {
      const res = await backend.send('call_tool', { name, args: args ?? {} });

      return res;
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `Error: ${e?.message || 'Backend unavailable'}` }],
        isError: true,
      } as any;
    }
  });

  const transport = new StdioServerTransport();

  await mcp.connect(transport);
}

startWrapper().catch(err => {
  console.error('Wrapper failed:', err);

  process.exit(1);
});
