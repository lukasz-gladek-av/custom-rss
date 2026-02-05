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
  getFetchConcurrency,
  getItemContent,
  hasArticleChanged,
  loadExistingItems,
  mapWithConcurrency,
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

const skipSitesMatches = ['destructoid.com', 'polygon.com', 'gamesindustry.biz', 'vgbees.com'];
const fetchConcurrency = getFetchConcurrency(4);

function extractHrefFromContent(htmlContent) {
  if (!htmlContent) {
    return null;
  }

  const $ = cheerio.load(htmlContent);
  return $('a').first().attr('href') || null;
}

async function fetchAndProcessFeed() {
  const existingArticles = await loadExistingItems('gaming.xml');
  const parsedFeed = await rssParser.parseURL(originalFeedUrl);
  const parsedItems = parsedFeed.items || [];

  console.log(`Processing ${parsedItems.length} items with concurrency=${fetchConcurrency}`);
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
    addItemToDomainFeed(result.linkDomain, result.articleItem);
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
  if (!url) {
    return null;
  }

  try {
    return new URL(url).hostname;
  } catch (error) {
    console.warn(`Invalid URL for domain extraction: ${url}`);
    return null;
  }
}

function sanitizeDomain(domain) {
  return domain
    .replace(/^www\./, '')
    .replace(/\./g, '_');
}

function addItemToDomainFeed(linkDomain, articleItem) {
  if (!linkDomain) {
    return;
  }

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

function shouldSkipItem(itemTitleLower) {
  return itemTitleLower?.startsWith('how to')
    || itemTitleLower?.includes(': how to')
    || itemTitleLower?.startsWith('where to find')
    || itemTitleLower?.startsWith('daily deals')
    || itemTitleLower?.startsWith('psa')
    || itemTitleLower?.startsWith('the maw')
    || itemTitleLower?.endsWith('? explained')
    || itemTitleLower?.endsWith('- answered')
    || itemTitleLower?.endsWith('– answered')
    || (itemTitleLower?.includes('save') && itemTitleLower?.includes('off'))
    || itemTitleLower?.includes('guide:');
}

async function processFeedItem(item, existingArticles) {
  const itemId = item.guid || item.id || item.link;
  const existingArticle = existingArticles.get(itemId);
  const itemTitleLower = item.title?.toLowerCase() || '';

  if (shouldSkipItem(itemTitleLower)) {
    return null;
  }

  try {
    const itemArticleContent = item['content:encoded'];
    const itemArticleLink = extractHrefFromContent(itemArticleContent);

    if (!itemArticleLink) {
      console.warn(`Missing article link for ${item.title}. Skipping.`);
      return null;
    }

    if (skipSitesMatches.some(site => itemArticleLink.includes(site))) {
      return null;
    }

    const requestConfig = {};
    if (existingArticle?.lastModified) {
      requestConfig.headers = {
        'If-Modified-Since': existingArticle.lastModified
      };
      requestConfig.validateStatus = (status) => status === 200 || status === 304;
    }

    const response = await fetchWithRetry(itemArticleLink, requestConfig);
    const linkDomain = getDomainFromUrl(itemArticleLink);

    if (response.status === 304 && existingArticle) {
      console.log(`Article unchanged (304): ${item.title}`);
      return {
        articleItem: buildItemFromExisting(existingArticle),
        linkDomain,
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
        content: article.content + '<br/><br/>' + itemArticleLink,
        author: [{ name: item.author || item.creator || 'Unknown', email: 'noreply@example.com' }],
      };

      if (lastModifiedHeader) {
        articleItem.custom_elements = [{ 'lastModified': lastModifiedHeader }];
      }

      return {
        articleItem,
        linkDomain,
        hasFeedChanges: hasArticleChanged(existingArticle?.item, articleItem, existingArticle?.lastModified)
      };
    }

    console.warn(`Failed to parse content for ${itemArticleContent || itemArticleLink}`);
    if (existingArticle) {
      return {
        articleItem: buildItemFromExisting(existingArticle),
        linkDomain,
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
      linkDomain,
      hasFeedChanges: hasArticleChanged(existingArticle?.item, fallbackItem, existingArticle?.lastModified)
    };
  } catch (err) {
    console.error(`Error processing ${item.title}:`, err.message);
    if (existingArticle) {
      const cachedItem = buildItemFromExisting(existingArticle);
      return {
        articleItem: cachedItem,
        linkDomain: getDomainFromUrl(cachedItem.link),
        hasFeedChanges: false
      };
    }

    return null;
  }
}

fetchAndProcessFeed();
