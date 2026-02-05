const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const fs = require('fs');
const {
  addDcCreatorToXml,
  buildItemFromExisting,
  createRssParser,
  fetchWithRetry,
  getItemContent,
  hasArticleChanged,
  loadExistingItems,
  removeStylesAndImages
} = require('./lib/feed-utils');

// Parse command-line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: node fetch-eurogamer.js <feedUrl> <outputFile> <feedTitle> <feedDescription>');
  console.error('Example: node fetch-eurogamer.js https://www.eurogamer.net/feed eurogamer_net_full.xml "Eurogamer.net RSS Feed" "Full article content from Eurogamer.net"');
  process.exit(1);
}

const [originalFeedUrl, outputFile, feedTitle, feedDescription] = args;

const rssParser = createRssParser();
const feed = new Feed({
  title: feedTitle,
  description: feedDescription,
  link: `https://lukasz-gladek-av.github.io/custom-rss/${outputFile}`,
});

async function fetchAndProcessFeed() {
  console.log(`Fetching ${feedTitle} from ${originalFeedUrl}...`);
  const existingArticles = await loadExistingItems(outputFile);
  let hasFeedChanges = false;
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);

  for (const item of parsedFeed.items) {
    try {
      // Get article link
      const itemArticleLink = item.link;
      const itemId = item.link || item.guid || item.id;

      // Check if article already exists
      const existingArticle = existingArticles.get(itemId);
      let lastModifiedHeader = null;

      // Fetch the article content with conditional request if we have lastModified
      const requestConfig = {};
      if (existingArticle && existingArticle.lastModified) {
        requestConfig.headers = {
          'If-Modified-Since': existingArticle.lastModified
        };
        requestConfig.validateStatus = (status) => status === 200 || status === 304;
      }

      const response = await fetchWithRetry(itemArticleLink, requestConfig);

      // Handle 304 Not Modified - reuse existing content
      if (response.status === 304 && existingArticle) {
        console.log(`Article unchanged (304): ${item.title}`);
        feed.addItem(buildItemFromExisting(existingArticle));
        continue;
      }

      // Handle 200 OK - fetch and process new content
      const html = response.data;
      lastModifiedHeader = response.headers['last-modified'] || null;
      const filteredHtml = removeStylesAndImages(html);

      // Use JSDOM and Readability to extract the main content
      const doc = new JSDOM(filteredHtml, { url: itemArticleLink });
      const reader = new Readability(doc.window.document);
      const article = reader.parse();

      if (article) {
        const articleId = itemId;
        const articleItem = {
          title: item.title,
          id: articleId,
          link: itemArticleLink,
          content: itemArticleLink + '<br/><br/>' + article.content,
          author: [{ name: item.author || item.creator || 'Unknown', email: 'noreply@example.com' }],
        };

        // Add Last-Modified header if present
        if (lastModifiedHeader) {
          articleItem.custom_elements = [{ 'lastModified': lastModifiedHeader }];
        }

        if (hasArticleChanged(existingArticle?.item, articleItem, existingArticle?.lastModified)) {
          hasFeedChanges = true;
        }
        feed.addItem(articleItem);
      } else {
        const fallbackIdentifier = itemArticleLink || item.link || item.title || 'Unknown item';
        console.warn(`Failed to parse content for ${fallbackIdentifier}`);

        if (existingArticle) {
          feed.addItem(buildItemFromExisting(existingArticle));
          continue;
        }

        const fallbackItem = {
          title: item.title,
          id: itemId,
          link: itemArticleLink,
          content: getItemContent(item),
          author: [{ name: item.author || item.creator || 'Unknown', email: 'noreply@example.com' }]
        };

        if (lastModifiedHeader) {
          fallbackItem.custom_elements = [{ 'lastModified': lastModifiedHeader }];
        }

        if (hasArticleChanged(existingArticle?.item, fallbackItem, existingArticle?.lastModified)) {
          hasFeedChanges = true;
        }
        feed.addItem(fallbackItem);
      }
    } catch (err) {
      console.error(`Error processing ${item.title}:`, err.message);
    }
  }

  if (!hasFeedChanges) {
    console.log(`No feed changes found for ${feedTitle}; skipping feed update.`);
    return;
  }

  let rssXml = feed.rss2();
  rssXml = addDcCreatorToXml(rssXml);
  fs.writeFileSync(outputFile, rssXml);
  console.log(`Successfully updated ${outputFile} with full articles.`);
}

fetchAndProcessFeed();
