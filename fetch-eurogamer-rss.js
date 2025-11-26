const RSSParser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const parserOptions = {
  customFields: {
    item: ['lastModified']
  }
};

const rssParser = new RSSParser(parserOptions);
const existingFeedParser = new RSSParser(parserOptions);
const originalFeedUrl = 'https://www.eurogamer.pl/feed';
const feed = new Feed({
  title: 'maEurogamerPL RSS Feed',
  description: 'A cleaned-up version of the original Eurogamer.pl feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/eurogamerpl.xml',
});

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
  const existingArticles = await loadExistingItems('eurogamerpl.xml');
  let hasNewArticles = false;
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);

  for (const item of parsedFeed.items) {
    try {
      // Get article link
      const itemArticleLink = item.link;

      // Check if article already exists
      const existingArticle = existingArticles.get(item.link);
      let lastModifiedHeader = null;

      // Fetch the article content with conditional request if we have lastModified
      const requestConfig = {};
      if (existingArticle && existingArticle.lastModified) {
        requestConfig.headers = {
          'If-Modified-Since': existingArticle.lastModified
        };
        requestConfig.validateStatus = (status) => status === 200 || status === 304;
      }

      const response = await axios.get(itemArticleLink, requestConfig);

      // Handle 304 Not Modified - reuse existing content
      if (response.status === 304 && existingArticle) {
        console.log(`Article unchanged (304): ${item.title}`);
        feed.addItem({
          title: existingArticle.item.title,
          id: existingArticle.item.guid || existingArticle.item.id || existingArticle.item.link,
          link: existingArticle.item.link,
          content: existingArticle.item['content:encoded'] || existingArticle.item.content,
          author: [{ name: existingArticle.item.author || existingArticle.item.creator || 'Unknown', email: 'noreply@example.com' }],
          custom_elements: [{ 'lastModified': existingArticle.lastModified }]
        });
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
        const articleId = item.link;
        if (!existingArticles.has(articleId)) {
          hasNewArticles = true;
        }

        const articleItem = {
          title: item.title,
          id: item.link,
          link: itemArticleLink,
          content: itemArticleLink + '<br/><br/>' + article.content,
          author: [{ name: item.author || item.creator || 'Unknown', email: 'noreply@example.com' }],
        };

        // Add Last-Modified header if present
        if (lastModifiedHeader) {
          articleItem.custom_elements = [{ 'lastModified': lastModifiedHeader }];
        }

        feed.addItem(articleItem);
      } else {
        const fallbackIdentifier = itemArticleLink || item.link || item.title || 'Unknown item';
        console.warn(`Failed to parse content for ${fallbackIdentifier}`);
        if (!existingArticles.has(item.link)) {
          hasNewArticles = true;
        }
        feed.addItem(item);
      }
    } catch (err) {
      console.error(`Error processing ${item}:`, err);
    }
  }

  if (!hasNewArticles) {
    console.log('No new Eurogamer articles found; skipping feed update.');
    return;
  }

  let rssXml = feed.rss2();
  rssXml = addDcCreatorToXml(rssXml);
  fs.writeFileSync('eurogamerpl.xml', rssXml);
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
