const RSSParser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const parserOptions = {
  customFields: {
    item: ['lastModified']
  }
};

function createRssParser() {
  return new RSSParser(parserOptions);
}

async function fetchWithRetry(url, config = {}, maxRetries = 4) {
  const delays = [2000, 4000, 8000, 16000];
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
    const parsedFeed = await createRssParser().parseString(xmlData);
    const items = new Map();

    for (const item of parsedFeed.items || []) {
      const id = item.guid || item.id || item.link;
      if (id) {
        items.set(id, {
          item,
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

function addDcCreatorToXml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });

  $('item').each((i, item) => {
    const $item = $(item);
    const $author = $item.find('author').first();

    if ($author.length > 0) {
      const authorText = $author.text();
      const match = authorText.match(/\(([^)]+)\)/);
      const authorName = match ? match[1] : authorText;

      $author.after(`<dc:creator>${authorName}</dc:creator>`);
      $author.remove();
    }
  });

  return $.html();
}

function removeStylesAndImages(html) {
  const $ = cheerio.load(html);
  $('style').remove();
  $('img').remove();
  $('link[rel="stylesheet"]').remove();
  $('[style]').removeAttr('style');
  return $.html();
}

module.exports = {
  addDcCreatorToXml,
  buildItemFromExisting,
  createRssParser,
  extractLastModified,
  fetchWithRetry,
  getItemContent,
  hasArticleChanged,
  loadExistingItems,
  removeStylesAndImages
};
