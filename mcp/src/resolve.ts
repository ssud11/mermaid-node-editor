// Resolve a tool's flow source (inline `text` or a `path`) into the text + the
// `isMmd` flag that the parser needs, plus light helpers for picking a block.
import { readFileSync } from 'node:fs';
import { findMermaidBlocks, type MermaidBlock } from '../../src/parser';

export interface FlowSource {
  /** Inline Mermaid/Markdown content. */
  text?: string;
  /** Path to a `.mmd`/`.mermaid` or `.md`/`.markdown` file (read from disk). */
  path?: string;
}

export interface ResolvedSource {
  text: string;
  /** true = the whole text is one diagram (`.mmd`); false = scan ```mermaid fences. */
  isMmd: boolean;
  path?: string;
}

/** Resolve {text|path} → {text, isMmd}. Throws on neither/unreadable. */
export function resolveSource(src: FlowSource): ResolvedSource {
  if (src.path != null && src.path !== '') {
    const text = readFileSync(src.path, 'utf8');
    const isMmd = /\.(mmd|mermaid)$/i.test(src.path);
    return { text, isMmd, path: src.path };
  }
  if (src.text != null) {
    // Inline: a fenced ```mermaid block ⇒ treat as Markdown; otherwise the text
    // is a raw diagram (whole-text = one block). The fence must START a line (up to
    // 3 spaces of indent per CommonMark) — anchored so the literal `` ```mermaid ``
    // appearing INSIDE a node label can't misflip a real flowchart into markdown mode.
    const isMmd = !/^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b/im.test(src.text);
    return { text: src.text, isMmd };
  }
  throw new Error('provide either `text` (inline) or `path` (a file to read)');
}

export function getBlocks(r: ResolvedSource): MermaidBlock[] {
  return findMermaidBlocks(r.text, r.isMmd);
}

/**
 * Pick a block by index, else the first SUPPORTED (flowchart) block, else the
 * first block. Returns the block + its index, or null when there are none.
 */
export function pickBlock(
  blocks: MermaidBlock[],
  index?: number
): { block: MermaidBlock; index: number } | null {
  if (blocks.length === 0) {
    return null;
  }
  if (index != null) {
    const block = blocks[index];
    return block ? { block, index } : null;
  }
  const sIdx = blocks.findIndex((b) => b.supported);
  const i = sIdx >= 0 ? sIdx : 0;
  return { block: blocks[i], index: i };
}
