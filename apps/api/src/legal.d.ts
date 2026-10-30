/** Markdown files are bundled as text (the `Text` module rule in wrangler.jsonc). */
declare module '*.md' {
  const text: string;
  export default text;
}
