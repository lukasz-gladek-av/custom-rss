const RSSParser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

// Parse command-line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: node fetch-eurogamer.js <feedUrl> <outputFile> <feedTitle> <feedDescription>');
  console.error('Example: node fetch-eurogamer.js https://www.eurogamer.net/feed eurogamer_net_full.xml "Eurogamer.net RSS Feed" "Full article content from Eurogamer.net"');
  process.exit(1);
}

const [originalFeedUrl, outputFile, feedTitle, feedDescription] = args;

const parserOptions = {
  customFields: {
    item: ['lastModified']
  }
};

const rssParser = new RSSParser(parserOptions);
const existingFeedParser = new RSSParser(parserOptions);
const feed = new Feed({
  title: feedTitle,
  description: feedDescription,
  link: `https://lukasz-gladek-av.github.io/custom-rss/${outputFile}`,
});

async function fetchWithRetry(url, config = {}, maxRetries = 4) {
  const delays = [2000, 4000, 8000, 16000]; // Exponential backoff in milliseconds
  const defaultRequestConfig = { timeout: 10000 };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const mergedConfig = { ...defaultRequestConfig, ...config };
      return await axios.get(url, mergedConfig);
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetriableError = error.code === 'ECONNRESET'
        || error.code === 'ETIMEDOUT'
        || error.code === 'ENOTFOUND'
        || error.code === 'EAI_AGAIN'
        || (error.response && error.response.status >= 500);

      if (!isRetriableError || isLastAttempt) {
        throw error;
      }

      const delay = delays[attempt];
      console.log(`Retry ${attempt + 1}/${maxRetries} for ${url} after ${delay}ms (${error.code || error.response?.status})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function extractLastModified(item) {
  if (!item) {
    return null;
  }

  if (item.lastModified || item['lastModified']) {
    return item.lastModified || item['lastModified'];
  }

  if (Array.isArray(item.custom_elements)) {
    for (const element of item.custom_elements) {
      if (element && Object.prototype.hasOwnProperty.call(element, 'lastModified')) {
        return element.lastModified;
      }
    }
  }

  return null;
}

function extractAuthorName(item) {
  if (!item) {
    return 'Unknown';
  }

  if (Array.isArray(item.author) && item.author.length > 0 && item.author[0]?.name) {
    return item.author[0].name;
  }

  return item.author || item.creator || 'Unknown';
}

function getItemContent(item) {
  return item?.['content:encoded'] || item?.content || '';
}

function hasArticleChanged(existingArticle, articleItem, existingLastModified) {
  if (!existingArticle) {
    return true;
  }

  const existingLastModifiedValue = existingLastModified || extractLastModified(existingArticle) || '';
  const nextLastModifiedValue = extractLastModified(articleItem) || '';

  return existingArticle.title !== articleItem.title
    || (existingArticle.guid || existingArticle.id || existingArticle.link) !== articleItem.id
    || existingArticle.link !== articleItem.link
    || getItemContent(existingArticle) !== articleItem.content
    || extractAuthorName(existingArticle) !== extractAuthorName(articleItem)
    || existingLastModifiedValue !== nextLastModifiedValue;
}

function buildItemFromExisting(existingArticleData) {
  const articleItem = {
    title: existingArticleData.item.title,
    id: existingArticleData.item.guid || existingArticleData.item.id || existingArticleData.item.link,
    link: existingArticleData.item.link,
    content: getItemContent(existingArticleData.item),
    author: [{ name: extractAuthorName(existingArticleData.item), email: 'noreply@example.com' }]
  };

  if (existingArticleData.lastModified) {
    articleItem.custom_elements = [{ 'lastModified': existingArticleData.lastModified }];
  }

  return articleItem;
}

async function loadExistingItems(filePath) {
  try {
    const xmlData = await fs.promises.readFile(filePath, 'utf8');
    const parsedFeed = await existingFeedParser.parseString(xmlData);
    const items = new Map();

    for (const item of parsedFeed.items || []) {
      const id = item.guid || item.id || item.link;
      if (id) {
        items.set(id, {
          item: item,
          lastModified: extractLastModified(item)
        });
      }
    }

    return items;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Unable to read existing feed from ${filePath}:`, error);
    }

    return new Map();
  }
}

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
        if (hasArticleChanged(existingArticle?.item, fallbackItem, existingArticle?.lastModified)) {
          hasFeedChanges = true;
        }
        feed.addItem(item);
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

function addDcCreatorToXml(xml) {
  // Post-process the XML to convert <author> tags to <dc:creator> tags
  const $ = cheerio.load(xml, { xmlMode: true });

  $('item').each((i, item) => {
    const $item = $(item);
    const $author = $item.find('author').first();

    if ($author.length > 0) {
      const authorText = $author.text();
      // Extract name from "email (name)" format
      const match = authorText.match(/\(([^)]+)\)/);
      const authorName = match ? match[1] : authorText;

      // Add dc:creator tag after author tag
      $author.after(`<dc:creator>${authorName}</dc:creator>`);

      // Remove the author tag
      $author.remove();
    }
  });

  return $.html();
}

function removeStylesAndImages(html) {
  const $ = cheerio.load(html);
  // Remove all <style> tags
  $('style').remove();
  $('img').remove();
  // Remove all <link rel="stylesheet"> tags
  $('link[rel="stylesheet"]').remove();
  // Remove all inline styles
  $('[style]').removeAttr('style');
  return $.html();
}

fetchAndProcessFeed();
