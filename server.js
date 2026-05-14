const http = require('node:http');
const { URL } = require('node:url');
const cheerio = require('cheerio');

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const config = {
  port: positiveInt(process.env.PORT, 3000),
  authToken: process.env.AUTH_TOKEN || '',
  timeoutMs: positiveInt(process.env.REQUEST_TIMEOUT_MS, 15000),
  maxSearchResults: positiveInt(process.env.MAX_SEARCH_RESULTS, 10),
  metadataConcurrency: positiveInt(process.env.METADATA_CONCURRENCY, 3),
  addAudiolibrixLinkToDescription: bool(process.env.ADD_AUDIOLIBRIX_LINK_TO_DESCRIPTION, true),
};

const BASE_URL = 'https://www.audiolibrix.cz';
const SEARCH_URL = `${BASE_URL}/en/Search/Results`;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'text/html,application/xhtml+xml',
};

function cleanText(value) {
  return (value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .trim();
}

function absoluteUrl(url, baseUrl = BASE_URL) {
  if (!url) return undefined;
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${baseUrl}${url}`;
  return `${baseUrl}/${url}`;
}

function cleanCoverUrl(url) {
  return absoluteUrl(url);
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: HTTP_HEADERS,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseDuration(durationStr) {
  const value = cleanText(durationStr).toLowerCase();
  if (!value) return undefined;

  let match = value.match(/(\d{1,3})\s*:\s*(\d{1,2})\s*h/);
  if (match) {
    return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
  }

  match = value.match(/(?:(\d+)\s*(?:h|hour|hours|hod|hodin|hodina))?\s*(?:(\d+)\s*(?:m|min|minute|minutes|minut))?/i);
  if (match && (match[1] || match[2])) {
    return Number.parseInt(match[1] || '0', 10) * 60 + Number.parseInt(match[2] || '0', 10);
  }

  return undefined;
}

function parseSeries(value) {
  const raw = cleanText(value);
  if (!raw) return [];

  const match = raw.match(/^(.+?)\s*#\s*([0-9]+(?:\.[0-9]+)?)$/);

  if (match) {
    return [{
      series: cleanText(match[1]),
      sequence: cleanText(match[2]),
    }];
  }

  return [{
    series: raw,
  }];
}

function splitPeople(value) {
  return cleanText(value)
    .split(/,|;|\s+and\s+|\s+a\s+/i)
    .map(cleanText)
    .filter(Boolean);
}

function normalizeLanguage(value) {
  const lang = cleanText(value).toLowerCase();

  if (!lang) return undefined;
  if (lang.includes('czech') || lang.includes('česk')) return 'czech';
  if (lang.includes('slovak') || lang.includes('sloven')) return 'slovak';
  if (lang.includes('english') || lang.includes('ang')) return 'english';
  if (lang.includes('german') || lang.includes('něm') || lang.includes('neme')) return 'german';

  return lang;
}

function getMeta($, name) {
  return cleanText($(`meta[property="${name}"], meta[name="${name}"]`).attr('content'));
}

function bookScope($) {
  return $('.book-wrapper[itemtype="http://schema.org/Book"], .book-wrapper').first();
}

function metadataScope($) {
  return bookScope($).find('.alx-metadata').first();
}

function scopedItempropText($, scope, prop) {
  const element = scope.find(`[itemprop="${prop}"]`).first();

  return cleanText(
    element.attr('content')
    || element.attr('alt')
    || element.attr('title')
    || element.text(),
  );
}

function scopedItempropList($, scope, prop) {
  return scope.find(`[itemprop="${prop}"]`)
    .map((_, el) => cleanText(
      $(el).attr('content')
      || $(el).attr('alt')
      || $(el).attr('title')
      || $(el).text(),
    ))
    .get()
    .filter(Boolean);
}

function normalizeLabels(labelNames) {
  const labels = Array.isArray(labelNames) ? labelNames : [labelNames];

  return labels.map((label) => cleanText(label).toLowerCase());
}

function findMetadataValue($, labelNames) {
  const scope = metadataScope($);
  const normalizedLabels = normalizeLabels(labelNames);
  let found = '';

  scope.find('dt').each((_, dt) => {
    if (found) return;

    const label = cleanText($(dt).text()).replace(/:$/, '').toLowerCase();

    if (normalizedLabels.includes(label)) {
      found = cleanText($(dt).next('dd').text());
    }
  });

  return found;
}

function findMetadataLinks($, labelNames) {
  const scope = metadataScope($);
  const normalizedLabels = normalizeLabels(labelNames);
  let links = [];

  scope.find('dt').each((_, dt) => {
    if (links.length) return;

    const label = cleanText($(dt).text()).replace(/:$/, '').toLowerCase();
    if (!normalizedLabels.includes(label)) return;

    const dd = $(dt).next('dd');

    links = dd.find('a')
      .map((_, a) => cleanText($(a).text()))
      .get()
      .filter(Boolean);

    if (!links.length) {
      links = splitPeople(dd.text());
    }
  });

  return links;
}

function extractDescription($) {
  const html = $('[id="#alx-publisher-summary"], #alx-publisher-summary').first().html();
  return cleanHtml(html || '');
}

function extractBookId(url) {
  const match = (url || '').match(/\/Directory\/Book\/(\d+)/i);
  return match ? match[1] : url;
}

function detailUrlFromInput(input) {
  const value = cleanText(input);

  if (/^https?:\/\/(?:www\.)?audiolibrix\.cz\/.*\/Directory\/Book\/\d+/i.test(value)) {
    return value;
  }

  if (/^\/.*\/Directory\/Book\/\d+/i.test(value)) {
    return absoluteUrl(value);
  }

  return null;
}

function extractSearchMatches($) {
  const seen = new Set();
  const matches = [];

  $('a[href*="/Directory/Book/"]').each((_, a) => {
    const url = absoluteUrl($(a).attr('href'));
    if (!url || seen.has(url)) return;

    seen.add(url);

    const nearby = $(a).closest('article, li, .item, .product, .book, .row, .col, div');

    const title = cleanText($(a).attr('title'))
      || cleanText($(a).find('img').attr('alt'))
      || cleanText($(a).text())
      || cleanText(nearby.find('h1,h2,h3,h4').first().text());

    matches.push({
      id: extractBookId(url),
      title: title.replace(/^Audiobook\s+/i, '').replace(/^Audiokniha\s+/i, ''),
      url,
      cover: cleanCoverUrl($(a).find('img').attr('src') || nearby.find('img').first().attr('src')),
    });
  });

  return matches;
}

async function mapWithConcurrency(items, iteratorFn, limit) {
  const results = new Array(items.length);
  let index = 0;

  await Promise.all(
    Array(Math.min(limit, items.length))
      .fill()
      .map(async () => {
        while (index < items.length) {
          const current = index++;

          try {
            results[current] = await iteratorFn(items[current]);
          } catch (err) {
            console.error('Metadata item error:', err.message || err);
            results[current] = null;
          }
        }
      }),
  );

  return results;
}

async function searchBooks(query, author = '') {
  const directDetail = detailUrlFromInput(query);

  if (directDetail) {
    const metadata = await getFullMetadata({
      id: extractBookId(directDetail),
      title: query,
      url: directDetail,
    });

    return metadata ? [metadata] : [];
  }

  const searchQuery = cleanText([query, author].filter(Boolean).join(' '));
  const searchUrl = `${SEARCH_URL}?query=${encodeURIComponent(searchQuery)}`;

  const $ = cheerio.load(await fetchHtml(searchUrl));
  const candidates = extractSearchMatches($).slice(0, config.maxSearchResults);

  const matches = await mapWithConcurrency(
    candidates,
    getFullMetadata,
    config.metadataConcurrency,
  );

  return matches.filter(Boolean);
}

async function getFullMetadata(match) {
  const $ = cheerio.load(await fetchHtml(match.url));

  const book = bookScope($);
  const metadata = metadataScope($);

  const rawTitle = scopedItempropText($, book, 'name')
    || cleanText($('h1').first().text())
    || getMeta($, 'og:title')
    || match.title;

  const title = rawTitle
    .replace(/^Audiobook\s+/i, '')
    .replace(/^Audiokniha\s+/i, '')
    .replace(/\s+-\s+Audiobooks.*$/i, '')
    .replace(/\s+-\s+Audioknihy.*$/i, '')
    .trim();

  const authors = scopedItempropList($, metadata, 'author');
  const publisher = scopedItempropText($, metadata, 'publisher');
  const genres = scopedItempropList($, metadata, 'genre');
  const languageRaw = scopedItempropText($, metadata, 'inLanguage');

  const narrators = findMetadataLinks($, ['Narrator', 'Interpret']);
  const durationStr = findMetadataValue($, ['Length', 'Délka']);
  const seriesRaw = findMetadataValue($, ['Serie', 'Série']);

  const descriptionHtml = extractDescription($);

  const cover = cleanCoverUrl(getMeta($, 'og:image'))
    || cleanCoverUrl($('.alx-audiobook-thumbnail img, .cover img, .book-cover img, .product-cover img').first().attr('src'))
    || match.cover;

  const descriptionParts = [];

  if (config.addAudiolibrixLinkToDescription) {
    descriptionParts.push(`<p><a href="${match.url}">Audiolibrix link</a></p>`);
  }

  if (descriptionHtml) {
    descriptionParts.push(descriptionHtml);
  }

  const result = {
    title,
    author: authors.join(', ') || undefined,
    narrator: narrators.join(', ') || undefined,
    publisher: publisher || undefined,
    description: descriptionParts.join('') || undefined,
    cover,
    genres: genres.length ? genres : undefined,
    language: normalizeLanguage(languageRaw),
    duration: parseDuration(durationStr),
  };

  const series = parseSeries(seriesRaw);

  if (series.length) {
    result.series = series;
  }

  return result;
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });

  res.end(data);
}

function isAuthorized(req) {
  return !config.authToken || req.headers.authorization === config.authToken;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      return jsonResponse(res, 200, {
        ok: true,
        provider: 'Audiolibrix.cz',
      });
    }

    if (url.pathname !== '/search') {
      return jsonResponse(res, 404, {
        error: 'Not found',
      });
    }

    if (!isAuthorized(req)) {
      return jsonResponse(res, 401, {
        error: 'Unauthorized',
      });
    }

    const query = url.searchParams.get('query') || url.searchParams.get('title') || '';
    const author = url.searchParams.get('author') || '';

    if (!query) {
      return jsonResponse(res, 400, {
        error: 'Missing query or title parameter',
      });
    }

    const matches = await searchBooks(query, author);

    return jsonResponse(res, 200, {
      matches,
    });
  } catch (err) {
    console.error(err);

    return jsonResponse(res, 500, {
      error: 'Internal server error',
    });
  }
});

server.listen(config.port, () => {
  console.log(`Audiolibrix.cz ABS provider listening on port ${config.port}`);
  console.log(`Auth: ${config.authToken ? 'enabled' : 'disabled'}, max results: ${config.maxSearchResults}, concurrency: ${config.metadataConcurrency}`);
});