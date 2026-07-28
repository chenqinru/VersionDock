import { useEffect, useState } from 'react';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import css from 'shiki/langs/css.mjs';
import go from 'shiki/langs/go.mjs';
import html from 'shiki/langs/html.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import python from 'shiki/langs/python.mjs';
import shell from 'shiki/langs/shell.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

let highlighterInstance: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore> | null = null;

function ensureHighlighter(): Promise<HighlighterCore> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);

  if (!highlighterPromise) {
    // The aggregate `shiki` entrypoint eagerly exposes every bundled grammar.
    // Supplying the registrations directly keeps the merge-editor bundle limited
    // to the languages we actually support while preserving the same API.
    highlighterPromise = createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [javascript, typescript, json, css, html, markdown, java, xml, yaml, php, python, go, shell],
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

export function useShiki(): HighlighterCore | null {
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(highlighterInstance);

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
