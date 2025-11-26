# AGENTS.md - Custom RSS Feed Aggregator

This document provides a comprehensive guide for AI assistants working with this codebase.

## Project Overview

This is an automated RSS feed aggregator that:
- Fetches gaming news from ResetEra's gaming headlines RSS feed
- Extracts full article content from various gaming news sites
- Creates cleaned-up RSS feeds with full article text (no styles/images)
- Generates both a combined feed (`gaming.xml`) and per-domain feeds
- Runs automatically via GitHub Actions every hour
- Implements intelligent caching using HTTP Last-Modified headers

**Live Feed URL**: https://lukasz-gladek-av.github.io/custom-rss/gaming.xml

## Architecture

```
┌─────────────────┐
│ GitHub Actions  │ (Runs hourly via cron)
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ fetch-rss.js (Main feed processor)      │
│ - Fetches ResetEra RSS feed             │
│ - Filters unwanted article types        │
│ - Extracts full articles                │
│ - Implements HTTP caching (304)         │
│ - Generates gaming.xml + per-domain XML │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ fetch-eurogamer.js (Generic processor)  │
│ - Reusable script for single-site feeds │
│ - Used for Eurogamer.net & .pl         │
│ - Same caching logic as main script     │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Output: XML Feeds                        │
│ - gaming.xml (combined feed)             │
│ - domain_specific.xml (per-site feeds)   │
│ - eurogamer_net_full.xml                 │
│ - eurogamerpl.xml                        │
└─────────────────────────────────────────┘
```

## Repository Structure

```
custom-rss/
├── .github/
│   └── workflows/
│       └── fetch-rss.yml          # GitHub Actions workflow (hourly cron)
├── fetch-rss.js                   # Main RSS aggregator script
├── fetch-eurogamer.js             # Generic single-feed processor
├── gaming.xml                     # Combined RSS feed output
├── [domain]_[tld].xml            # Per-domain feed outputs (e.g., ign_com.xml)
├── eurogamer_net_full.xml        # Full Eurogamer.net articles
├── eurogamerpl.xml               # Full Eurogamer.pl articles
├── index.html                     # Placeholder HTML (not actively used)
├── package.json                   # Node.js dependencies
├── CLAUDE.md                      # Links to this file
└── AGENTS.md                      # This file
```

## Key Files Explained

### fetch-rss.js (Lines: 329)
**Purpose**: Main RSS feed aggregator for ResetEra gaming headlines

**Key Functions**:
- `fetchWithRetry(url, config, maxRetries)` (27-50): HTTP request wrapper with retry logic
  - Implements exponential backoff (2s, 4s, 8s, 16s delays)
  - Retries up to 4 times on network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN)
  - Retries on server errors (5xx status codes)
  - Does not retry on client errors (4xx) to avoid wasting resources
  - Logs retry attempts for debugging

- `fetchAndProcessFeed()` (137-284): Main orchestration function
  - Fetches ResetEra RSS feed
  - Filters out unwanted content (guides, deals, etc.)
  - Processes each article through full-text extraction
  - Handles HTTP 304 caching for unchanged articles
  - Uses retry logic for all article fetches
  - Generates combined + per-domain feeds

- `loadExistingItems(filePath)` (71-95): Loads cached feed items
  - Returns Map of existing articles with lastModified timestamps
  - Used for intelligent HTTP caching

- `extractHrefFromContent(htmlContent)` (97-135): Extracts article URL from RSS item
  - Parses HTML content to find the first anchor tag
  - Includes JSDOM optimization to disable CSS processing

- `removeStylesAndImages(html)` (311-321): Cleans HTML content
  - Removes `<style>`, `<img>`, and stylesheet links
  - Strips inline styles
  - Keeps semantic HTML for readability

- `addDcCreatorToXml(xml)` (286-309): Converts author format
  - Changes `<author>` tags to `<dc:creator>` for RSS compatibility
  - Extracts author name from "email (name)" format

- `getDomainFromUrl(url)` (323-326): Extracts domain from URL

**Content Filtering** (143-158):
Skips articles matching patterns:
- "how to" guides
- "where to find" guides
- "daily deals"
- "PSA" posts
- "explained" content
- Sale/discount articles
- Articles from blocked sites: destructoid.com, polygon.com, gamesindustry.biz, vgbees.com

**HTTP Caching Logic** (179-215):
- Sends `If-Modified-Since` header if we have lastModified timestamp
- On 304 response: reuses existing article content (no re-fetch)
- On 200 response: fetches and parses new content with retry logic

### fetch-eurogamer.js (Lines: 235)
**Purpose**: Generic, reusable script for fetching single-site RSS feeds

**Command-line Usage**:
```bash
node fetch-eurogamer.js <feedUrl> <outputFile> <feedTitle> <feedDescription>
```

**Example**:
```bash
node fetch-eurogamer.js \
  "https://www.eurogamer.net/feed" \
  "eurogamer_net_full.xml" \
  "Eurogamer.net RSS Feed" \
  "Full article content from Eurogamer.net"
```

**Key Functions**:
- `fetchWithRetry(url, config, maxRetries)` (33-56): HTTP request wrapper with retry logic (same as fetch-rss.js)

**Key Differences from fetch-rss.js**:
- No content filtering (processes all articles)
- Takes feed URL as command-line argument
- Simpler: doesn't create per-domain feeds
- Single output file

**Shared Logic**:
- Same HTTP caching mechanism
- Same retry logic with exponential backoff
- Same Readability parsing
- Same author metadata handling

### .github/workflows/fetch-rss.yml
**Purpose**: GitHub Actions automation

**Schedule**: Runs every hour (`cron: "* */1 * * *"`)

**Workflow Steps**:
1. Checkout repository
2. Setup Node.js 18
3. Cache npm dependencies
4. Install dependencies (`npm ci`)
5. Run `fetch-rss.js`
6. Run `fetch-eurogamer.js` for Eurogamer.net
7. Run `fetch-eurogamer.js` for Eurogamer.pl
8. Commit and push updated XML files (if changes detected)

## Key Dependencies

```json
{
  "@mozilla/readability": "^0.5.0",  // Content extraction
  "axios": "^1.6.8",                 // HTTP requests
  "cheerio": "^1.0.0-rc.12",         // HTML parsing/manipulation
  "feed": "^4.2.2",                  // RSS feed generation
  "jsdom": "^24.0.0",                // DOM parsing for Readability
  "rss-parser": "^3.13.0"            // RSS feed parsing
}
```

### Why These Libraries?

- **@mozilla/readability**: Firefox's article extraction algorithm - excellent at identifying main content
- **axios**: HTTP client with robust header support (needed for `If-Modified-Since`)
- **cheerio**: Fast, jQuery-like HTML manipulation for cleaning HTML
- **feed**: Clean API for generating RSS 2.0 feeds
- **jsdom**: Required by Readability for DOM parsing
- **rss-parser**: Parses incoming RSS feeds with custom field support

## Development Workflow

### Making Changes

1. **Testing Locally**:
```bash
npm install
node fetch-rss.js              # Test main feed
node fetch-eurogamer.js ...    # Test Eurogamer feeds
```

2. **Adding New Site Filters**:
   - Edit `skipSitesMatches` array in fetch-rss.js:25
   ```javascript
   const skipSitesMatches = ['destructoid.com', 'polygon.com', ...]
   ```

3. **Adding Content Filters**:
   - Edit filtering logic in fetch-rss.js:119-134
   - Add new pattern matching conditions

4. **Adding New Single-Site Feed**:
   - Add new step in `.github/workflows/fetch-rss.yml`
   ```yaml
   - name: Run YourSite Fetch Script
     run: node fetch-eurogamer.js "https://yoursite.com/feed" "yoursite.xml" "Title" "Description"
   ```

### Git Workflow

**Branch Naming Convention**:
- Feature branches: `claude/claude-md-mig1rj9fzaamcfeg-[session-id]`
- All branches must start with `claude/` and include session ID
- Push to designated branch only: `git push -u origin <branch-name>`

**Commit Message Conventions**:
```
Auto-update RSS feed at YYYY-MM-DD HH:MM:SS  # Automated commits
Add author metadata to RSS items (#12)        # Feature additions
Fetch full articles for Eurogamer (#13)       # Feature additions
Ensure cached feeds retain lastModified (#11) # Bug fixes
```

**Main Branch**: Default branch for PRs (check git remote info)

## RSS Feed Processing Details

### Caching Strategy

**Purpose**: Avoid re-fetching unchanged articles, reducing bandwidth and processing time

**Implementation**:
1. Parse existing XML feed into Map of items (key: article ID)
2. For each article, extract `lastModified` custom field
3. Send HTTP request with `If-Modified-Since: <lastModified>` header
4. Server responds:
   - **304 Not Modified**: Reuse existing content (saves ~99% processing time)
   - **200 OK**: Fetch and parse new content

**Custom Fields in RSS**:
```xml
<item>
  <title>Article Title</title>
  <link>https://...</link>
  <dc:creator>Author Name</dc:creator>
  <lastModified>Wed, 26 Nov 2025 12:00:00 GMT</lastModified>
  <content:encoded><![CDATA[...]]></content:encoded>
</item>
```

### Content Extraction Pipeline

1. **Fetch HTML**: `fetchWithRetry(url, config)` - Uses exponential backoff retry logic
2. **Clean HTML**: Remove styles, images, inline styles
3. **Parse with Readability**: Extract main article content
4. **Format**: Append source URL to content
5. **Add Metadata**: Title, link, author, lastModified
6. **Generate RSS**: Use `feed` library to create XML

### Network Resilience

**Retry Logic** (implemented in both fetch-rss.js and fetch-eurogamer.js):
- Automatically retries failed HTTP requests up to 4 times
- Uses exponential backoff delays: 2s, 4s, 8s, 16s
- Only retries on network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN) and server errors (5xx)
- Does not retry on client errors (4xx) to avoid wasting resources
- Logs each retry attempt with error code for debugging
- Prevents article loss due to transient network issues

### Author Metadata Handling

**Input Format** (from RSS):
```javascript
{ author: "email@example.com (Author Name)" }
```

**Processing**:
1. Feed library creates: `<author>email@example.com (Author Name)</author>`
2. Post-processing extracts name: `Author Name`
3. Converts to: `<dc:creator>Author Name</dc:creator>`
4. Removes original `<author>` tag

**Why?**: RSS readers expect `dc:creator` for author names, not email-based `<author>` tags

## Code Conventions

### Error Handling
- Use try-catch blocks around article processing (fetch-rss.js:135-243)
- Log errors with context: `console.error('Error processing ${item}:', err)`
- Continue processing on individual article failures
- Warn on missing/invalid data: `console.warn()`

### Logging
- Info: `console.log()` for successful operations
- Warnings: `console.warn()` for non-critical issues
- Errors: `console.error()` for failures

### Variable Naming
- `camelCase` for variables and functions
- Descriptive names: `existingArticles`, `itemArticleLink`, `lastModifiedHeader`
- Maps for lookups: `existingArticles` (Map), `domainFeeds` (Map)

### JSDOM Optimization
The code includes extensive JSDOM configuration to disable CSS processing (fetch-rss.js:74-105):
- Prevents loading external resources
- Disables CSS parsing (major performance boost)
- Critical for processing many articles efficiently

## Common Tasks

### Add New Content Filter
**File**: fetch-rss.js:119-134

```javascript
if (
  itemTitleLower?.startsWith('how to')
  || itemTitleLower?.includes('new pattern')  // Add here
) {
  continue;
}
```

### Block New Site
**File**: fetch-rss.js:25

```javascript
const skipSitesMatches = [
  'destructoid.com',
  'polygon.com',
  'newsite.com'  // Add here
]
```

### Change Feed Update Frequency
**File**: .github/workflows/fetch-rss.yml:6

```yaml
schedule:
  - cron: "* */2 * * *"  # Change to every 2 hours
```

### Add New Feed Source
1. Decide: Use `fetch-rss.js` logic or create new script?
2. If single-site: Use `fetch-eurogamer.js` pattern
3. Add workflow step in `.github/workflows/fetch-rss.yml`
4. Test locally first

## Testing Changes

### Manual Testing
```bash
# Install dependencies
npm install

# Run main script (processes ResetEra feed)
node fetch-rss.js

# Run Eurogamer scripts
node fetch-eurogamer.js \
  "https://www.eurogamer.net/feed" \
  "eurogamer_net_full.xml" \
  "Eurogamer.net RSS Feed" \
  "Full article content from Eurogamer.net"

# Check generated XML
ls -lh *.xml
head -n 50 gaming.xml
```

### Validation
- Check XML files are valid (open in browser or RSS reader)
- Verify article content is clean (no styles, images removed)
- Confirm `<dc:creator>` tags present
- Check `lastModified` custom fields exist

## Important Notes for AI Assistants

1. **Never modify package-lock.json manually** - Use `npm install` to update
2. **Test locally before committing** - RSS parsing can fail on malformed HTML
3. **Preserve HTTP caching logic** - Critical for performance at scale
4. **Don't remove JSDOM CSS optimizations** - Major performance impact
5. **Follow existing error handling patterns** - Individual failures shouldn't break entire run
6. **Maintain content filtering lists** - User curates what appears in feed
7. **Keep per-domain feed generation** - Users subscribe to individual site feeds
8. **Preserve author metadata handling** - RSS readers depend on `dc:creator` format
9. **Preserve retry logic** - Critical for reliability; prevents article loss from transient network issues

## Recent Enhancements (from git log)

- **2025-11-26**: Implement retry logic for failed article fetches with exponential backoff (network resilience)
- **PR #13**: Fetch full articles for Eurogamer (generic script pattern)
- **PR #12**: Add author metadata to RSS items (`dc:creator` support)
- **PR #11**: Ensure cached feeds retain lastModified metadata (caching fix)

## Troubleshooting

### Issue: No new articles generated
**Cause**: All articles returned 304 (unchanged)
**Solution**: Expected behavior - feeds only update when content changes

### Issue: Readability parsing fails
**Cause**: Site has non-standard HTML structure
**Solution**: Add site to `skipSitesMatches` or implement custom parser

### Issue: GitHub Actions fails to commit
**Cause**: No XML files changed
**Solution**: Expected - workflow checks for changes before committing

### Issue: Memory issues with large feeds
**Cause**: JSDOM with CSS processing enabled
**Solution**: Ensure CSS optimization code (74-105) remains intact

## Performance Considerations

- **HTTP 304 caching**: Reduces processing time by ~99% for unchanged articles
- **JSDOM CSS disabling**: Saves ~60% memory per article
- **Image/style removal**: Reduces XML file size by ~80%
- **Per-domain feeds**: Allows users to subscribe to specific sites only
- **Retry logic with exponential backoff**: Prevents article loss from transient network issues without overwhelming servers

## Future Enhancement Ideas

- Add support for full-text search across feeds
- Implement article deduplication (same story from multiple sites)
- Add sentiment analysis or categorization
- Create web UI for feed management
- Add RSS feed health monitoring/alerting
- Add support for custom user-defined filters
