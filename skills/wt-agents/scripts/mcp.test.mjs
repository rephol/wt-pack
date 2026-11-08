// Run: node --test skills/wt-agents/scripts/mcp.test.mjs — MCP mode (full|lean) and the spawn args it gives.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), 'wt-mcp-'))
writeFileSync(join(tmp, 'herdr'), '#!/bin/sh\nexit 0\n'); chmodSync(join(tmp, 'herdr'), 0o755) // agents.sh only checks it is on PATH
const envFile = join(tmp, 'env')
const run = (cmd, args, env) => execFileSync(cmd, args, { cwd: join(here, '../..'), encoding: 'utf8',
  env: { PATH: `${tmp}:${process.env.PATH}`, HOME: tmp, XDG_CACHE_HOME: tmp, WT_DASHBOARD_ENV: envFile, ...env } }).trim()
const mode = (file, env = {}) => { writeFileSync(envFile, file); return run(join(here, '../../wt-shared/scripts/mcp-mode.sh'), [], env) }
const args = (file, extra = []) => { writeFileSync(envFile, file); return run(join(here, 'agents.sh'), ['mcp-args', 'worker', '.', ...extra]) }

test('mcp-mode: default full; the env file switch; WT_AGENTS_MCP overrides', () => {
  assert.equal(mode(''), 'full')
  assert.equal(mode('WT_AGENTS_MCP=lean\n'), 'lean')
  assert.equal(mode('export WT_AGENTS_MCP="lean"\n'), 'lean')
  assert.equal(mode('WT_AGENTS_MCP=full\n'), 'full')
  assert.equal(mode('WT_AGENTS_MCP=lean\n', { WT_AGENTS_MCP: 'full' }), 'full')
  assert.equal(mode('', { WT_AGENTS_MCP: 'lean' }), 'lean')
})

test('spawn args: full = no MCP flags (picks only add); lean = strict role set', () => {
  assert.equal(args(''), '')
  assert.equal(args('', ['--mcp', 'context7']), '--mcp-config\n["context7"]')
  assert.equal(args('WT_AGENTS_MCP=lean\n'), '--strict-mcp-config --mcp-config\n["wt-memory"]')
  assert.equal(args('WT_AGENTS_MCP=lean\n', ['--mcp', 'context7']), '--strict-mcp-config --mcp-config\n["context7","wt-memory"]')
})

test('auditor: lean set is wt-memory + context7', () => {
  writeFileSync(envFile, 'WT_AGENTS_MCP=lean\n')
  assert.equal(run(join(here, 'agents.sh'), ['mcp-args', 'auditor', '.']), '--strict-mcp-config --mcp-config\n["context7","wt-memory"]')
})

test('reviewer: lean set is wt-memory + context7', () => {
  writeFileSync(envFile, 'WT_AGENTS_MCP=lean\n')
  assert.equal(run(join(here, 'agents.sh'), ['mcp-args', 'reviewer', '.']), '--strict-mcp-config --mcp-config\n["context7","wt-memory"]')
})
