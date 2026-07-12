import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression test for A4: the CLI's shutdown handler (SIGINT/SIGTERM/transport.onclose) must
// be idempotent. Before the fix, a rapid double signal would run writeReport()/manager.close()
// twice concurrently. Spawns the real CLI over stdio (as the e2e suite does) and delivers two
// SIGINTs in quick succession.

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

describe('cli shutdown (A4 regression)', () => {
  it('exits cleanly exactly once on a rapid double SIGINT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-shutdown-test-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        downstreams: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', dir] },
        },
        report: { enabled: true, markdownPath: join(dir, 'report.md') },
      })
    );

    // Spawn the local tsx binary directly (not via `npx tsx`) so the process we signal is the
    // one actually running cli.ts - `npx` is an extra process hop that intercepts SIGINT
    // itself and exits with its own signal-terminated code instead of forwarding cleanly.
    const tsxBin = join(projectRoot, 'node_modules/.bin/tsx');
    const child = spawn(tsxBin, [join(projectRoot, 'src/cli.ts'), '--config', configPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    // Give the gateway time to connect the downstream before signaling shutdown.
    await new Promise((r) => setTimeout(r, 5000));

    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGINT'); // fired right after - must be a no-op, not a second shutdown

    const exitCode = await new Promise<number | null>((resolvePromise) => {
      child.on('exit', (code) => resolvePromise(code));
    });

    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/uncaught|unhandled/i);
    // "received SIGINT, shutting down" should appear at most once - a second, reentrant
    // shutdown() call would log it (and write the report) again.
    const shutdownLogs = stderr.match(/shutting down/g) ?? [];
    expect(shutdownLogs.length).toBe(1);
  }, 30_000);
});
