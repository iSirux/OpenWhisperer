#!/usr/bin/env node
/**
 * Patches the Claude Agent SDK to add windowsHide: true to spawn calls.
 * This prevents CMD windows from appearing on Windows when the SDK spawns
 * Claude Code for tool execution.
 *
 * This patch is applied via postinstall and should be re-applied after
 * any npm install that updates the SDK.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkPath = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');

// Check if SDK exists
if (!fs.existsSync(sdkPath)) {
  console.log('[patch-sdk] SDK not found, skipping patch (will be applied after install)');
  process.exit(0);
}

let content = fs.readFileSync(sdkPath, 'utf-8');

// Check if already patched or natively supported
if (content.includes('windowsHide:!0') || content.includes('windowsHide: true')) {
  console.log('[patch-sdk] SDK already has windowsHide support (native or patched)');
  process.exit(0);
}

// Find and patch the spawn call
// Original: spawn(spawnCommand, spawnArgs, { cwd, stdio: [...], signal: ..., env })
// Patched:  spawn(spawnCommand, spawnArgs, { cwd, stdio: [...], signal: ..., env, windowsHide: true })
const spawnPattern = /this\.child = spawn\(spawnCommand, spawnArgs, \{\s*cwd,\s*stdio: \["pipe", "pipe", stderrMode\],\s*signal: this\.abortController\.signal,\s*env\s*\}\);/;

const replacement = `this.child = spawn(spawnCommand, spawnArgs, {
        cwd,
        stdio: ["pipe", "pipe", stderrMode],
        signal: this.abortController.signal,
        env,
        windowsHide: true
      });`;

if (!spawnPattern.test(content)) {
  console.log('[patch-sdk] Spawn pattern not found - SDK may natively support windowsHide. Skipping patch.');
  process.exit(0);
}

content = content.replace(spawnPattern, replacement);
fs.writeFileSync(sdkPath, content);
console.log('[patch-sdk] Successfully patched SDK to hide Windows console windows');
