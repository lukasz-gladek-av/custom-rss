const RSSParser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const axios = require('axios');
const cheerio = require('cheerio');

const rssParser = new RSSParser();
const originalFeedUrl = 'https://www.eurogamer.pl/feed';
const feed = new Feed({
  title: 'maEurogamerPL RSS Feed',
  description: 'A cleaned-up version of the original Eurogamer.pl feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/eurogamerpl.xml',
});

async function fetchAndProcessFeed() {
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
        feed.addItem({
          title: item.title,
          id: item.link,
          link: itemArticleLink,
          content: itemArticleLink + '<br/><br/>' + article.content,
          author: [{ name: item.author || item.creator || 'Unknown' }],
        });
      } else {
        console.warn(`Failed to parse content for ${itemArticleContent || itemArticleLink}`);
        feed.addItem(item)
      }
    } catch (err) {
      console.error(`Error processing ${item}:`, err);
    }
  }

  const rssXml = feed.rss2();
  require('fs').writeFileSync('eurogamerpl.xml', rssXml);
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
