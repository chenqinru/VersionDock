import { useEffect, useState } from 'react';
import { createHighlighter, createJavaScriptRegexEngine, type Highlighter } from 'shiki';

let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

function ensureHighlighter(): Promise<Highlighter> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);

  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: ['javascript', 'typescript', 'json', 'css', 'html', 'markdown', 'java', 'xml', 'yaml', 'php', 'python', 'go', 'shell'],
      engine: createJavaScriptRegexEngine(),
    }).then(highlighter => {
      highlighterInstance = highlighter;
      return highlighter;
    }).catch(error => {
      highlighterPromise = null;
      throw error;
    });
  }

  return highlighterPromise;
}

export function useShiki(): Highlighter | null {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(highlighterInstance);

  useEffect(() => {
    let disposed = false;
    ensureHighlighter().then(instance => {
      if (!disposed) setHighlighter(instance);
    }).catch(() => {
      if (!disposed) setHighlighter(null);
    });

    return () => { disposed = true; };
  }, []);

  return highlighter;
}
