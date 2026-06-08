import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagramSource, extractMdFrontmatterConfig } from '../src/preview-source';

// --- buildDiagramSource: markdown fenced blocks ---

test('buildDiagramSource: extracts the text between markdown fences', () => {
  const md = ['# Title', '', '```mermaid', 'graph TD', 'A --> B', '```', 'after'].join('\n');
  // fence at line 2 (```mermaid), closing fence at line 5
  const src = buildDiagramSource(md, false, 2, 5);
  assert.equal(src, 'graph TD\nA --> B');
});

test('buildDiagramSource: lifts markdown frontmatter config (layout: elk) into the diagram', () => {
  const md = [
    '---',
    'cssclasses: show-line-numbers',
    'config:',
    '  layout: elk',
    '---',
    '',
    '```mermaid',
    'graph LR',
    'A --> B',
    '```',
  ].join('\n');
  // fence at line 6, closing at line 9
  const src = buildDiagramSource(md, false, 6, 9);
  assert.equal(src, '---\nconfig:\n  layout: elk\n---\ngraph LR\nA --> B');
});

test('buildDiagramSource: no config: key in frontmatter -> source unchanged', () => {
  const md = ['---', 'title: Hello', '---', '```mermaid', 'graph TD', 'A --> B', '```'].join('\n');
  const src = buildDiagramSource(md, false, 3, 6);
  assert.equal(src, 'graph TD\nA --> B');
});

test('buildDiagramSource: a fence whose first line is blank then --- is NOT treated as frontmatter (inject still happens)', () => {
  // mermaid only honors `---` at byte 0; a leading blank line invalidates it, so
  // the page-level config:layout:elk must still be lifted in (regression: the old
  // /^\s*---/ guard matched the leading \n and wrongly suppressed injection).
  const md = [
    '---',
    'config:',
    '  layout: elk',
    '---',
    '```mermaid',
    '', // blank first content line inside the fence
    '---',
    'config:',
    '  theme: dark',
    '---',
    'graph TD',
    'A --> B',
    '```',
  ].join('\n');
  // fence opens at line 4, closes at line 12; content is lines 5..11
  const src = buildDiagramSource(md, false, 4, 12);
  assert.ok(src.startsWith('---\nconfig:\n  layout: elk\n---\n'), 'page-level elk config is injected at byte 0');
  assert.ok(src.includes('theme: dark'), 'the original (mispositioned) block frontmatter is preserved as content');
});

test('buildDiagramSource: does not double-inject when the fenced block already has its own frontmatter', () => {
  const md = [
    '---',
    'config:',
    '  layout: elk',
    '---',
    '```mermaid',
    '---',
    'config:',
    '  theme: dark',
    '---',
    'graph TD',
    'A --> B',
    '```',
  ].join('\n');
  // fence at line 4, closing at line 11 — block content starts with its own ---
  const src = buildDiagramSource(md, false, 4, 11);
  assert.ok(src.startsWith('---\nconfig:\n  theme: dark'), 'keeps the block-local frontmatter');
  assert.ok(!src.includes('layout: elk'), 'page-level config is NOT injected over the block-local one');
});

// --- buildDiagramSource: .mmd whole-file ---

test('buildDiagramSource: .mmd returns the whole file (block lines ignored)', () => {
  const mmd = 'flowchart TD\n  A --> B\n  B --> C';
  const src = buildDiagramSource(mmd, true, 0, 2);
  assert.equal(src, mmd);
});

// --- extractMdFrontmatterConfig directly ---

test('extractMdFrontmatterConfig: pulls config: and its indented children only', () => {
  const lines = ['---', 'title: X', 'config:', '  layout: elk', '  theme: dark', 'other: y', '---', 'graph TD'];
  assert.equal(extractMdFrontmatterConfig(lines), 'config:\n  layout: elk\n  theme: dark');
});

test('extractMdFrontmatterConfig: no leading frontmatter -> undefined', () => {
  assert.equal(extractMdFrontmatterConfig(['graph TD', 'A --> B']), undefined);
});

test('extractMdFrontmatterConfig: unterminated frontmatter -> undefined', () => {
  assert.equal(extractMdFrontmatterConfig(['---', 'config:', '  layout: elk', 'graph TD']), undefined);
});

test('extractMdFrontmatterConfig: frontmatter without config -> undefined', () => {
  assert.equal(extractMdFrontmatterConfig(['---', 'title: X', '---']), undefined);
});
