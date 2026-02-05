const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { Feed } = require('feed');
const cheerio = require('cheerio');
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

const rssParser = createRssParser();
const originalFeedUrl = 'https://www.resetera.com/forums/gaming-headlines.54/index.rss';
const feed = new Feed({
  title: 'maGaming RSS Feed',
  description: 'A cleaned-up version of the original gaming feed',
  link: 'https://lukasz-gladek-av.github.io/custom-rss/gaming.xml',
});
const domainFeeds = new Map();

const skipSitesMatches = ['destructoid.com', 'polygon.com', 'gamesindustry.biz', 'vgbees.com']

function extractHrefFromContent(htmlContent) {
  if (!htmlContent) {
    return null;
  }

  const $ = cheerio.load(htmlContent);
  return $('a').first().attr('href') || null;
}

async function fetchAndProcessFeed() {
  const existingArticles = await loadExistingItems('gaming.xml');
  let hasFeedChanges = false;
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);

  for (const item of parsedFeed.items) {
    const itemId = item.guid || item.id || item.link;
    const existingArticle = existingArticles.get(itemId);
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
        articleItem = buildItemFromExisting(existingArticle);
        feed.addItem(articleItem);

        // Per domain
        const linkDomain = getDomainFromUrl(itemArticleLink);
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
          id: itemId,
          link: itemArticleLink,
          content: article.content + '<br/><br/>' + itemArticleLink,
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

        // Per domain
        const linkDomain = getDomainFromUrl(itemArticleLink);
        addItemToDomainFeed(linkDomain, articleItem);
      } else {
        console.warn(`Failed to parse content for ${itemArticleContent || itemArticleLink}`);

        if (existingArticle) {
          articleItem = buildItemFromExisting(existingArticle);
          feed.addItem(articleItem);
          const linkDomain = getDomainFromUrl(itemArticleLink);
          addItemToDomainFeed(linkDomain, articleItem);
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
        const linkDomain = getDomainFromUrl(itemArticleLink);
        addItemToDomainFeed(linkDomain, fallbackItem);
      }
    } catch (err) {
      console.error(`Error processing ${item.title}:`, err.message);
      if (existingArticle) {
        const cachedItem = buildItemFromExisting(existingArticle);
        feed.addItem(cachedItem);
        const linkDomain = getDomainFromUrl(cachedItem.link);
        addItemToDomainFeed(linkDomain, cachedItem);
      }
    }
  }

  if (!hasFeedChanges) {
    console.log('No feed changes found; skipping feed update.');
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
