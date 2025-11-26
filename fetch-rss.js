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
const originalFeedUrl = 'https://www.resetera.com/forums/gaming-headlines.54/index.rss';
const feed = new Feed({
  title: 'maGaming RSS Feed',
  description: 'A cleaned-up version of the original gaming feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/gaming.xml',
});
const domainFeeds = new Map();

const skipSitesMatches = ['destructoid.com', 'polygon.com', 'gamesindustry.biz', 'vgbees.com']

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

  if (item.lastModified) {
    return item.lastModified;
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
  const existingArticles = await loadExistingItems('gaming.xml');
  let hasNewArticles = false;
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

      if (!itemArticleLink) {
        console.warn(`Missing article link for ${item.title}. Skipping.`);
        continue;
      }

      if (skipSitesMatches.some(site => itemArticleLink.includes(site))) {
        continue;
      }

      // Check if article already exists
      const existingArticle = existingArticles.get(item.link);
      let articleItem;
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
        articleItem = {
          title: existingArticle.item.title,
          id: existingArticle.item.guid || existingArticle.item.id || existingArticle.item.link,
          link: existingArticle.item.link,
          content: existingArticle.item['content:encoded'] || existingArticle.item.content,
          author: [{ name: existingArticle.item.author || existingArticle.item.creator || 'Unknown', email: 'noreply@example.com' }],
          custom_elements: [{ 'lastModified': existingArticle.lastModified }]
        };
        feed.addItem(articleItem);

        // Per domain
        const linkDomain = sanitizeDomain(getDomainFromUrl(itemArticleLink));
        addItemToDomainFeed(linkDomain, articleItem);
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
        articleItem = {
          title: item.title,
          id: item.link,
          link: itemArticleLink,
          content: article.content + '<br/><br/>' + itemArticleLink,
          author: [{ name: item.author || item.creator || 'Unknown', email: 'noreply@example.com' }],
        };

        // Add Last-Modified header if present
        if (lastModifiedHeader) {
          articleItem.custom_elements = [{ 'lastModified': lastModifiedHeader }];
        }

        if (!existingArticles.has(articleItem.id)) {
          hasNewArticles = true;
        }
        feed.addItem(articleItem);

        // Per domain
        const linkDomain = sanitizeDomain(getDomainFromUrl(itemArticleLink));
        addItemToDomainFeed(linkDomain, articleItem);
      } else {
        console.warn(`Failed to parse content for ${itemArticleContent || itemArticleLink}`);
        if (!existingArticles.has(item.link)) {
          hasNewArticles = true;
        }
        feed.addItem(item)
      }
    } catch (err) {
      console.error(`Error processing ${item}:`, err);
    }
  }

  if (!hasNewArticles) {
    console.log('No new articles found; skipping feed update.');
    return;
  }

  let rssXml = feed.rss2();
  rssXml = addDcCreatorToXml(rssXml);
  fs.writeFileSync('gaming.xml', rssXml);
  domainFeeds.forEach((domainFeedData, domainKey) => {
    const { feed: domainFeed, originalDomain } = domainFeedData;

    console.log('domain', originalDomain);
    let domainRssXml = domainFeed.rss2();
    domainRssXml = addDcCreatorToXml(domainRssXml);
    fs.writeFileSync(domainKey + '.xml', domainRssXml);
  });
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

function getDomainFromUrl(url) {
    const domain = new URL(url).hostname;
    return domain;
}

function sanitizeDomain(domain) {
  return domain
    .replace(/^www\./, '')
    .replace(/\./g, '_');
}

function addItemToDomainFeed(linkDomain, articleItem) {
  const domainKey = sanitizeDomain(linkDomain);

  if (!domainFeeds.get(domainKey)) {
    domainFeeds.set(domainKey, {
      feed: new Feed({
        title: 'maGaming RSS Feed - ' + linkDomain,
        description: 'A cleaned-up version of the original gaming feed for ' + linkDomain,
        link: 'https://lukasz-gladek-av.github.io/custom-rss/' + domainKey + '.xml',
      }),
      originalDomain: linkDomain,
    });
  }

  domainFeeds.get(domainKey).feed.addItem(articleItem);
}

fetchAndProcessFeed();
