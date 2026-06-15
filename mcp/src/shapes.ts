// Map a node's bracket tokens to a human/agent-friendly shape name for
// flow_extract output. Mirrors Mermaid's flowchart node shapes.
const SHAPE_BY_OPEN: Record<string, string> = {
  '[': 'rectangle',
  '(': 'rounded',
  '([': 'stadium',
  '[[': 'subroutine',
  '[(': 'cylinder',
  '((': 'circle',
  '{': 'diamond',
  '{{': 'hexagon',
  '>': 'asymmetric',
};

/** Shape name from the opening bracket token; '' (bare node) → 'bare'. */
export function shapeOf(open: string): string {
  if (open === '') {
    return 'bare';
  }
  return SHAPE_BY_OPEN[open] ?? 'rectangle';
}
