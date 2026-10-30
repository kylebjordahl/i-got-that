# Legal documents

The published Privacy Policy and Terms of Service. The API worker imports these
files as text and serves them, rendered to HTML, at:

| File | URL |
| --- | --- |
| `privacy-policy.md` | `<PUBLIC_ORIGIN>/legal/privacy` |
| `terms-of-service.md` | `<PUBLIC_ORIGIN>/legal/terms` |

Editing a file here and deploying is how the published text changes. The
renderer (`apps/api/src/lib/legal.ts`) supports a deliberately small Markdown
subset — `#`/`##`/`###` headings, paragraphs, `-` and `1.` lists, `**bold**`,
`*italic*`, `` `code` ``, and `[text](url)` links — so keep to that. Bump the
"Last updated" line whenever the substance changes.
