const RSSParser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const axios = require('axios');

const rssParser = new RSSParser();
const originalFeedUrl = 'https://www.resetera.com/forums/gaming-headlines.54/index.rss';
const feed = new Feed({
  title: 'maGaming RSS Feed',
  description: 'A cleaned-up version of the original gaming feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/gaming.xml',
});

function extractHrefFromContent(htmlContent) {
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;
  const anchor = document.querySelector('a');
  
  // If an anchor tag exists, return the href attribute
  return anchor ? anchor.href : null;
}

async function fetchAndProcessFeed() {
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);

  for (const item of parsedFeed.items) {
    try {
      // Get article link
      const itemArticleContent= item['content:encoded'];
      const itemArticleLink = extractHrefFromContent(itemArticleContent);
      
      // Fetch the article content
      const response = await axios.get(itemArticleLink);
      const html = response.data;

      // Use JSDOM and Readability to extract the main content
      const doc = new JSDOM(html, { url: itemArticleLink });
      const reader = new Readability(doc.window.document);
      const article = reader.parse();

      if (article) {
        feed.addItem({
          title: item.title,
          id: item.link,
          link: item.link,
          content: article.content,
          author: [{ name: item.author || 'Unknown' }],
        });
      } else {
        console.warn(`Failed to parse content for ${itemArticleLink}`);
      }
    } catch (err) {
      console.error(`Error processing ${itemArticleLink}:`, err);
    }
  }

  const rssXml = feed.rss2();
  require('fs').writeFileSync('gaming.xml', rssXml);
}

fetchAndProcessFeed();
