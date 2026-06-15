// Pure (vscode-free) helpers that build the renderable Mermaid source for the
// live preview. Kept out of the vscode layer — like parser.ts / editor.ts — so
// the load-bearing source-shaping logic unit-tests in plain Node.

/**
 * The Mermaid source to hand the renderer for a block:
 *  - `.mmd`: the whole file.
 *  - markdown: the text between the ``` fences.
 *
 * If a markdown file's leading YAML frontmatter sets a mermaid `config:` (e.g.
 * `layout: elk`) and the fenced source has no frontmatter of its own, that
 * config is lifted in so the preview matches how the `.md` actually renders
 * (Obsidian-style ELK files put `layout: elk` in the page
 * frontmatter, outside the fence).
 *
 * @param fullText       the whole document text
 * @param isMmd          true for `.mmd`/`.mermaid` (whole file is the diagram)
 * @param blockStartLine line of the opening ``` fence (markdown only)
 * @param blockEndLine   line of the closing ``` fence (markdown only)
 */
export function buildDiagramSource(
  fullText: string,
  isMmd: boolean,
  blockStartLine: number,
  blockEndLine: number
): string {
  const lines = fullText.split(/\r?\n/);
  let src = isMmd ? fullText : lines.slice(blockStartLine + 1, blockEndLine).join('\n');
  // Suppress injection only when the fenced source GENUINELY begins with its own
  // `---` frontmatter. Anchor at position 0 (no leading whitespace): mermaid only
  // recognises `---` as frontmatter at byte 0, so a fence that starts with a blank
  // line then `---` is NOT mermaid frontmatter and still needs the page config.
  if (!isMmd && !/^---\n/.test(src)) {
    const cfg = extractMdFrontmatterConfig(lines);
    if (cfg) {
      src = `---\n${cfg}\n---\n${src}`;
    }
  }
  return src;
}

/** Lift a top-level `config:` mapping out of a markdown file's leading `--- … ---` frontmatter. */
export function extractMdFrontmatterConfig(lines: string[]): string | undefined {
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return undefined;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return undefined; // unterminated frontmatter — treat as none
  }
  let start = -1;
  for (let i = 1; i < end; i++) {
    if (/^config\s*:/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return undefined;
  }
  const out = [lines[start].replace(/\s+$/, '')];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    if (/^\s/.test(line)) {
      out.push(line.replace(/\s+$/, '')); // indented child of config:
    } else {
      break; // next top-level key ends the config block
    }
  }
  return out.join('\n');
}
