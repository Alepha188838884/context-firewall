// @mixmark-io/domino ships lib/index.d.ts as `declare module 'domino'` (the pre-fork package
// name), so it does not actually type the `@mixmark-io/domino` import specifier we use. This is
// a minimal local declaration covering only the API extract-main.ts calls.
declare module '@mixmark-io/domino' {
  interface DominoElement {
    outerHTML: string;
    innerHTML: string;
    textContent: string | null;
    tagName: string;
    remove(): void;
    querySelectorAll(selector: string): DominoElement[];
    contains(other: unknown): boolean;
  }

  interface DominoDocument {
    querySelector(selector: string): DominoElement | null;
    querySelectorAll(selector: string): DominoElement[];
    body: DominoElement | null;
  }

  function createDocument(html?: string): DominoDocument;

  const domino: { createDocument: typeof createDocument };
  export default domino;
}
