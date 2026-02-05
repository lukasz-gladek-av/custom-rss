const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const fs = require('fs');
const {
  addDcCreatorToXml,
  buildItemFromExisting,
  createHostRequestLimiter,
  createRssParser,
  fetchWithRetry,
  getFetchConcurrency,
  getPerHostConcurrency,
  getItemContent,
  hasArticleChanged,
  loadExistingItems,
  mapWithConcurrency,
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
const fetchConcurrency = getFetchConcurrency(4);
const perHostConcurrency = getPerHostConcurrency(2);
const runWithHostLimit = createHostRequestLimiter({ perHostConcurrency });

async function fetchAndProcessFeed() {
  console.log(`Fetching ${feedTitle} from ${originalFeedUrl}...`);
  const existingArticles = await loadExistingItems(outputFile);
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);
  const parsedItems = parsedFeed.items || [];

  console.log(`Processing ${parsedItems.length} items with concurrency=${fetchConcurrency}, perHostConcurrency=${perHostConcurrency}`);
  const processingResults = await mapWithConcurrency(
    parsedItems,
    fetchConcurrency,
    (item) => processFeedItem(item, existingArticles)
  );

  let hasFeedChanges = false;
  for (const result of processingResults) {
    if (!result?.articleItem) {
      continue;
    }

    if (result.hasFeedChanges) {
      hasFeedChanges = true;
    }

    feed.addItem(result.articleItem);
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

async function processFeedItem(item, existingArticles) {
  const itemId = item.link || item.guid || item.id;
  const existingArticle = existingArticles.get(itemId);

  try {
    const itemArticleLink = item.link;
    const requestConfig = {};

    if (existingArticle?.lastModified) {
      requestConfig.headers = {
        'If-Modified-Since': existingArticle.lastModified
      };
      requestConfig.validateStatus = (status) => status === 200 || status === 304;
    }

    const response = await runWithHostLimit(
      itemArticleLink,
      () => fetchWithRetry(itemArticleLink, requestConfig)
    );
    if (response.status === 304 && existingArticle) {
      console.log(`Article unchanged (304): ${item.title}`);
      return {
        articleItem: buildItemFromExisting(existingArticle),
        hasFeedChanges: false
      };
    }

    const lastModifiedHeader = response.headers['last-modified'] || null;
    const filteredHtml = removeStylesAndImages(response.data);
    const doc = new JSDOM(filteredHtml, { url: itemArticleLink });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (article) {
      const articleItem = {
        title: item.title,
        id: itemId,
        link: itemArticleLink,
        content: itemArticleLink + '<br/><br/>' + article.content,
        author: [{ name: item.author || item.creator || 'Unknown', email: 'noreply@example.com' }],
      };

      if (lastModifiedHeader) {
        articleItem.custom_elements = [{ 'lastModified': lastModifiedHeader }];
      }

      return {
        articleItem,
        hasFeedChanges: hasArticleChanged(existingArticle?.item, articleItem, existingArticle?.lastModified)
      };
    }

    const fallbackIdentifier = itemArticleLink || item.link || item.title || 'Unknown item';
    console.warn(`Failed to parse content for ${fallbackIdentifier}`);
    if (existingArticle) {
      return {
        articleItem: buildItemFromExisting(existingArticle),
        hasFeedChanges: false
      };
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

    return {
      articleItem: fallbackItem,
      hasFeedChanges: hasArticleChanged(existingArticle?.item, fallbackItem, existingArticle?.lastModified)
    };
  } catch (err) {
    console.error(`Error processing ${item.title}:`, err.message);
    if (existingArticle) {
      return {
        articleItem: buildItemFromExisting(existingArticle),
        hasFeedChanges: false
      };
    }

    return null;
  }
}

fetchAndProcessFeed();
