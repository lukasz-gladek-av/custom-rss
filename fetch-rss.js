const RSSParser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const axios = require('axios');
const cheerio = require('cheerio');

const rssParser = new RSSParser();
const originalFeedUrl = 'https://www.resetera.com/forums/gaming-headlines.54/index.rss';
const feed = new Feed({
  title: 'maGaming RSS Feed',
  description: 'A cleaned-up version of the original gaming feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/gaming.xml',
});
const domainFeeds = new Map();

const skipSitesMatches = ['destructoid.com', 'polygon.com', 'gamesindustry.biz', 'vgbees.com']

function extractHrefFromContent(htmlContent) {
  const dom = new JSDOM(htmlContent, {
    resources: "usable",  // Ensures that some resources like images or frames are loaded
    includeNodeLocations: true,
    pretendToBeVisual: true,  // Makes JSDOM behave like a visual browser
    features: {
        FetchExternalResources: false, // Prevents loading of external resources like stylesheets
        ProcessExternalResources: false // Prevents processing of external scripts and styles
    },
    beforeParse(window) {
        // This disables all CSS processing
        window.document.styleSheets = {
            length: 0,
            item: () => null
        };
        // This disables all CSS processing by setting dummy functions and ignoring style elements
        window.document.createElement = (function (nativeCreateElement) {
          return function (tagName) {
              if (tagName.toLowerCase() === 'style') {
                  const element = nativeCreateElement.call(window.document, 'style');
                  // These are dummy functions to avoid any parsing
                  element.sheet = {
                      cssRules: [],
                      insertRule: function() {},
                      deleteRule: function() {},
                  };
                  return element;
              }
              return nativeCreateElement.call(window.document, tagName);
          };
      })(window.document.createElement);
    }
});
  const document = dom.window.document;
  const anchor = document.querySelector('a');
  
  // If an anchor tag exists, return the href attribute
  return anchor ? anchor.href : null;
}

async function fetchAndProcessFeed() {
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);

  for (const item of parsedFeed.items) {
    const itemTitleLower = item.title.toLowerCase();
    if (
      itemTitleLower?.startsWith('how to')
      || itemTitleLower?.includes(': how to')
      || itemTitleLower?.startsWith('where to find')
      || itemTitleLower?.startsWith('daily deals')
      || itemTitleLower?.startsWith('psa')
      || itemTitleLower?.startsWith('the maw')
      || itemTitleLower?.endsWith('? explained')
      || itemTitleLower?.endsWith('- answered')
      || itemTitleLower?.endsWith('– answered')
      || (itemTitleLower?.includes('save') && (itemTitleLower?.includes('off')))
      || itemTitleLower.includes('guide:')
    ) {
      continue;
    }
    try {
      // Get article link
      const itemArticleContent = item['content:encoded'];
      const itemArticleLink = extractHrefFromContent(itemArticleContent);

      if (skipSitesMatches.some(site => itemArticleLink.includes(site))) {
        continue;
      }
      
      // Fetch the article content
      const response = await axios.get(itemArticleLink);
      const html = response.data;
      const filteredHtml = removeStylesAndImages(html);

      // Use JSDOM and Readability to extract the main content
      const doc = new JSDOM(filteredHtml, { url: itemArticleLink });
      const reader = new Readability(doc.window.document);
      const article = reader.parse();

      if (article) {
        const articleItem = {
          title: item.title,
          id: item.link,
          link: itemArticleLink,
          content: article.content + '<br/><br/>' + itemArticleLink,
          author: [{ name: item.author || item.creator || 'Unknown' }],
        };
        feed.addItem(articleItem);

        // Per domain
        const linkDomain = getDomainFromUrl(itemArticleLink)
                             .replace('www.', '')
                             .replace('.', '_');
        if (!domainFeeds.get(linkDomain)) {
          domainFeeds.set(linkDomain, new Feed({
                             title: 'maGaming RSS Feed - ' + linkDomain,
                             description: 'A cleaned-up version of the original gaming feed for ' + linkDomain,
                             link: 'https://lukasz-gladek-av.github.io/custom-rss/' + linkDomain + ".xml",
                           }));
        }
        domainFeeds.get(linkDomain).addItem(articleItem);
      } else {
        console.warn(`Failed to parse content for ${itemArticleContent || itemArticleLink}`);
        feed.addItem(item)
      }
    } catch (err) {
      console.error(`Error processing ${item}:`, err);
    }
  }

  const rssXml = feed.rss2();
  require('fs').writeFileSync('gaming.xml', rssXml);
  domainFeeds.forEach((domainFeed, domainUrl) => {
  console.log('domain', domainUrl);
    const domainRssXml = domainFeed.rss2();
    require('fs').writeFileSync(domainUrl + '.xml', domainRssXml);
  });
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

function getDomainFromUrl(url) {
    const domain = new URL(url).hostname;
    return domain;
}

fetchAndProcessFeed();
