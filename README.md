# Custom RSS utilities

Scripts for fetching and cleaning up RSS feeds, producing full-content XML files suitable for publishing.

## Requirements
- Node.js 20+ (workflow currently runs on Node.js 22)
- `npm install` to install dependencies

## Usage

### Gaming headlines (ResetEra)
Generates a cleaned feed plus per-domain feeds for links found in the original ResetEra gaming headlines feed.

```bash
npm run fetch:gaming
```

Outputs:
- `gaming.xml` (cleaned feed)
- One XML file per linked domain (e.g., `example_com.xml`), created with sanitized filenames derived from the domain.

### Eurogamer full articles
Fetches the Eurogamer RSS feed, follows each link, and emits an XML file containing the full article content.

```bash
npm run fetch:eurogamer
```

Outputs:
- `eurogamer_net_full.xml`

### Eurogamer.pl full articles
```bash
npm run fetch:eurogamer:pl
```

Outputs:
- `eurogamerpl.xml`

### Run all feeds
```bash
npm run fetch:all
```

### Custom feeds
`fetch-eurogamer.js` accepts custom arguments if you want to point it at another source:

```bash
node fetch-eurogamer.js <feedUrl> <outputFile> <feedTitle> <feedDescription>
```

## Implementation highlights
- Retries with exponential backoff for network calls and a default request timeout.
- HTML stripping and Readability extraction to keep feed entries concise.
- Author metadata normalized to `dc:creator` for reader compatibility.
