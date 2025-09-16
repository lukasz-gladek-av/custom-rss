const RSSParser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const rssParser = new RSSParser();
const existingFeedParser = new RSSParser();
const originalFeedUrl = 'https://www.eurogamer.pl/feed';
const feed = new Feed({
  title: 'maEurogamerPL RSS Feed',
  description: 'A cleaned-up version of the original Eurogamer.pl feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/eurogamerpl.xml',
});

async function loadExistingItemIds(filePath) {
  try {
    const xmlData = await fs.promises.readFile(filePath, 'utf8');
    const parsedFeed = await existingFeedParser.parseString(xmlData);
    const ids = new Set();

    for (const item of parsedFeed.items || []) {
      const id = item.guid || item.id || item.link;
      if (id) {
        ids.add(id);
      }
    }

    return ids;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Unable to read existing feed from ${filePath}:`, error);
    }

    return new Set();
  }
}

async function fetchAndProcessFeed() {
  const existingArticleIds = await loadExistingItemIds('eurogamerpl.xml');
  let hasNewArticles = false;
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);

  for (const item of parsedFeed.items) {
    try {
      // Get article link
      const itemArticleLink = item.link;

      // Fetch the article content
      const response = await axios.get(itemArticleLink);
      const html = response.data;
      const filteredHtml = removeStylesAndImages(html);

      // Use JSDOM and Readability to extract the main content
      const doc = new JSDOM(filteredHtml, { url: itemArticleLink });
      const reader = new Readability(doc.window.document);
      const article = reader.parse();

      if (article) {
        const articleId = item.link;
        if (!existingArticleIds.has(articleId)) {
          hasNewArticles = true;
        }

        feed.addItem({
          title: item.title,
          id: item.link,
          link: itemArticleLink,
          content: itemArticleLink + '<br/><br/>' + article.content,
          author: [{ name: item.author || item.creator || 'Unknown' }],
        });
      } else {
        console.warn(`Failed to parse content for ${itemArticleContent || itemArticleLink}`);
        if (!existingArticleIds.has(item.link)) {
          hasNewArticles = true;
        }
        feed.addItem(item)
      }
    } catch (err) {
      console.error(`Error processing ${item}:`, err);
    }
  }

  if (!hasNewArticles) {
    console.log('No new Eurogamer articles found; skipping feed update.');
    return;
  }

  const rssXml = feed.rss2();
  fs.writeFileSync('eurogamerpl.xml', rssXml);
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
