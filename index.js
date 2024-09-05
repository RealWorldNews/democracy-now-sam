PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 1;
const chromium = process.env.AWS_EXECUTION_ENV ? require('@sparticuz/chromium') : null;
const puppeteer = require('puppeteer');
const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

const processBody = (body, link, resource = 'Democracy Now!') => {
  let formattedBody = '';

  if (body) {
    formattedBody += body; // Keep body content as extracted with formatting
  }

  formattedBody += `<br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
  return formattedBody;
};

const insertArticleIntoDatabase = async (client, article) => {
  await client.query(
    `INSERT INTO "Article" (id, slug, headline, summary, body, author, resource, media, link, date) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      article.id,
      article.slug,
      article.headline,
      article.summary || '',
      article.body || '',
      article.author,
      article.resource,
      article.media,
      article.link,
      article.date
    ]
  );
};

const convertDateToUTC = (dateString) => {
  const date = new Date(dateString);
  return date.toISOString();
};

const slugExists = async (client, slug) => {
  const result = await client.query('SELECT 1 FROM "Article" WHERE slug = $1', [slug]);
  return result.rowCount > 0;
};

const generateSlug = (headline) => {
  return headline.split(' ').slice(0, 3).join('').toLowerCase().replace(/[^a-z]/g, '');
};

const ensureUniqueSlug = async (client, headline) => {
  let slug = generateSlug(headline);
  let suffix = 1;

  while (await slugExists(client, slug)) {
    slug = `${generateSlug(headline)}-${suffix}`;
    suffix++;
  }

  return slug;
};

exports.handler = async (event, context) => {
  const websiteUrl = 'https://www.democracynow.org/headlines';

  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING_DEV
  });

  console.log('Connecting to the database...');
  try {
    await client.connect();
    console.log('Connected to the database successfully.');

    await client.query('DELETE FROM "Article" WHERE resource = $1', ['Democracy Now!']);
    console.log('Truncated existing articles with resource "Democracy Now!".');

    const browser = await puppeteer.launch({
      args: chromium ? chromium.args : [],
      defaultViewport: chromium ? chromium.defaultViewport : null,
      executablePath: chromium ? await chromium.executablePath() : puppeteer.executablePath(),
      headless: chromium ? chromium.headless : true,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    console.log('Navigating to Democracy Now! headlines page...');
    try {
      await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('Page loaded successfully');
    } catch (error) {
      console.error('Failed to load Democracy Now! headlines page:', error);
      await browser.close();
      await client.end();
      return;
    }

    const articles = await page.$$eval('.news_item', items =>
      items.map(item => {
        const headline = item.querySelector('h3 a')?.innerText.trim();
        const link = 'https://www.democracynow.org' + item.querySelector('h3 a')?.getAttribute('href').trim();
        const date = item.querySelector('.date')?.innerText.trim();
        return { headline, link, date };
      })
    );

    console.log('Collected headlines and links:', articles);

    for (const article of articles) {
      console.log(`Visiting article: ${article.headline}`);

      let success = false;
      let attempts = 0;
      article.slug = await ensureUniqueSlug(client, article.headline);

      while (!success && attempts < 3) {
        attempts++;
        try {
          await page.goto(article.link, { waitUntil: 'domcontentloaded', timeout: 10000 });

          // Extract the date
          try {
            const date = await page.$eval('.news_label .date', el => el.innerText.trim());
            article.date = convertDateToUTC(date);
          } catch (err) {
            console.error('Error finding date: ', err);
            article.date = new Date().toISOString().split('T')[0];
          }

          // Extract the body and summary
          try {
            const bodyContent = await page.$$eval('div.headline_summary p', paragraphs =>
              paragraphs.map(p => `<p>${p.innerText.trim()}</p>`).join('')
            );
            article.body = bodyContent;
            article.summary = bodyContent.replace(/<[^>]+>/g, '').split(' ').slice(0, 25).join(' ') + '...';
          } catch (err) {
            console.error('Error finding body content: ', err);
            article.body = '';
            article.summary = '';
          }

          // Extract the media
          try {
            const media = await page.$eval('article.headline img[itemprop="image"]', el => el.getAttribute('src'));
            article.media = media;
          } catch (err) {
            console.error('Error finding media content: ', err);
            article.media = 'https://npr.brightspotcdn.com/dims4/default/0f33387/2147483647/strip/true/crop/1200x630+0+260/resize/1200x630!/quality/90/?url=http%3A%2F%2Fnpr-brightspot.s3.amazonaws.com%2F69%2F34%2F879932ae4dbcbb5abb2f7dce90eb%2Fdemocracy-now-square-logo-2021.jpg';
          }

          article.body = processBody(article.body, article.link);
          article.author = 'See article for details'; // Placeholder since Democracy Now! doesn't list authors
          article.resource = 'Democracy Now!';
          article.id = cuid();

          // Insert into the database
          await insertArticleIntoDatabase(client, article);
          success = true;
          console.log(`Collected and saved data for article: ${article.headline}`);
        } catch (error) {
          console.error(`Error processing article: ${article.headline}, attempt ${attempts}`, error);
          if (attempts >= 3) {
            console.error(`Failed to load article after ${attempts} attempts.`);
          }
        }
      }
    }

    await browser.close();
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Scraping completed successfully', articles }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify('An error occurred during scraping'),
    };
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
};
