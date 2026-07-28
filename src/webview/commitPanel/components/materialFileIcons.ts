// Material Icon Theme SVG imports — bundled as inline text by esbuild
import svgFile         from 'material-icon-theme/icons/file.svg';
import svgReactTs      from 'material-icon-theme/icons/react_ts.svg';
import svgReact        from 'material-icon-theme/icons/react.svg';
import svgTypescript   from 'material-icon-theme/icons/typescript.svg';
import svgJavascript   from 'material-icon-theme/icons/javascript.svg';
import svgHtml         from 'material-icon-theme/icons/html.svg';
import svgCss          from 'material-icon-theme/icons/css.svg';
import svgSass         from 'material-icon-theme/icons/sass.svg';
import svgLess         from 'material-icon-theme/icons/less.svg';
import svgPhp          from 'material-icon-theme/icons/php.svg';
import svgPython       from 'material-icon-theme/icons/python.svg';
import svgRuby         from 'material-icon-theme/icons/ruby.svg';
import svgGo           from 'material-icon-theme/icons/go.svg';
import svgRust         from 'material-icon-theme/icons/rust.svg';
import svgJson         from 'material-icon-theme/icons/json.svg';
import svgMarkdown     from 'material-icon-theme/icons/markdown.svg';
import svgDatabase     from 'material-icon-theme/icons/database.svg';
import svgImage        from 'material-icon-theme/icons/image.svg';
import svgConsole      from 'material-icon-theme/icons/console.svg';
import svgToml         from 'material-icon-theme/icons/toml.svg';
import svgXml          from 'material-icon-theme/icons/xml.svg';
import svgTune         from 'material-icon-theme/icons/tune.svg';
import svgYaml         from 'material-icon-theme/icons/yaml.svg';
import svgFolder       from 'material-icon-theme/icons/folder.svg';
import svgFolderOpen   from 'material-icon-theme/icons/folder-open.svg';

// Map file extension → SVG string
export const EXT_ICON: Record<string, string> = {
  ts:   svgTypescript,
  tsx:  svgReactTs,
  js:   svgJavascript,
  jsx:  svgReact,
  mjs:  svgJavascript,
  cjs:  svgJavascript,
  html: svgHtml,
  htm:  svgHtml,
  css:  svgCss,
  scss: svgSass,
  sass: svgSass,
  less: svgLess,
  php:  svgPhp,
  py:   svgPython,
  rb:   svgRuby,
  go:   svgGo,
  rs:   svgRust,
  json: svgJson,
  jsonc: svgJson,
  md:   svgMarkdown,
  markdown: svgMarkdown,
  yaml: svgYaml,
  yml:  svgYaml,
  sql:  svgDatabase,
  png:  svgImage,
  jpg:  svgImage,
  jpeg: svgImage,
  gif:  svgImage,
  svg:  svgImage,
  webp: svgImage,
  sh:   svgConsole,
  bash: svgConsole,
  zsh:  svgConsole,
  toml: svgToml,
  xml:  svgXml,
  env:  svgTune,
};

export const FALLBACK_ICON: string = svgFile;
export const FOLDER_ICON: string = svgFolder;
export const FOLDER_OPEN_ICON: string = svgFolderOpen;

export function getFileIconSvg(filename: string): string {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  return EXT_ICON[ext] ?? FALLBACK_ICON;
}
