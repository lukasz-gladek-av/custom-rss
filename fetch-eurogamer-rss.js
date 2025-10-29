const RSSParser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const rssParser = new RSSParser();
const existingFeedParser = new RSSParser({
  customFields: {
    item: ['lastModified']
  }
});
const originalFeedUrl = 'https://www.eurogamer.pl/feed';
const feed = new Feed({
  title: 'maEurogamerPL RSS Feed',
  description: 'A cleaned-up version of the original Eurogamer.pl feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/eurogamerpl.xml',
});

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
          lastModified: item.lastModified || null
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
  const lastModifiedMap = new Map(); // Track guid -> lastModified timestamp

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
        const itemId = existingArticle.item.guid || existingArticle.item.id || existingArticle.item.link;
        lastModifiedMap.set(itemId, existingArticle.lastModified);
        feed.addItem({
          title: existingArticle.item.title,
          id: itemId,
          link: existingArticle.item.link,
          content: existingArticle.item['content:encoded'] || existingArticle.item.content,
          author: [{ name: existingArticle.item.author || existingArticle.item.creator || 'Unknown' }],
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
          author: [{ name: item.author || item.creator || 'Unknown' }],
        };

        // Track Last-Modified header if present
        if (lastModifiedHeader) {
          lastModifiedMap.set(articleItem.id, lastModifiedHeader);
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

  // Generate RSS and inject lastModified elements
  let rssXml = feed.rss2();
  rssXml = injectLastModified(rssXml, lastModifiedMap);
  fs.writeFileSync('eurogamerpl.xml', rssXml);
}

function injectLastModified(rssXml, lastModifiedMap) {
  const $ = cheerio.load(rssXml, { xmlMode: true });

  $('item').each((index, element) => {
    const $item = $(element);
    const guid = $item.find('guid').text();

    if (guid && lastModifiedMap.has(guid)) {
      const lastModified = lastModifiedMap.get(guid);
      // Insert lastModified element after guid
      $item.find('guid').after(`<lastModified>${lastModified}</lastModified>`);
    }
  });

  return $.xml();
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
