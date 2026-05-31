const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '35mb' }));

const PORT = process.env.PORT || 3000;
const IMED_BASE_URL = 'https://www.licencia.cl';
const IMED_RUT = process.env.IMED_RUT || '';
const IMED_PASS = process.env.IMED_PASS || '';

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'proxy-imed' });
});

app.post('/api/imed/licencias', async (req, res) => {
  let browser;
  try {
    assertCredentials();
    browser = await launchBrowser();

    const page = await browser.newPage();
    await configurePage(page);
    await loginImed(page);

    const listInfo = await loadPendingLicenses(page);
    const enriched = [];

    for (const rowLicense of listInfo.licencias) {
      if (!rowLicense.folioId) {
        enriched.push(normalizeLicense(rowLicense));
        continue;
      }

      try {
        const detailUrl = `${IMED_BASE_URL}/licencias/${encodeURIComponent(rowLicense.folioId)}`;
        await page.goto(detailUrl, { waitUntil: 'networkidle2' });
        await waitForBodyText(page);
        const detail = await extractDetailFromPage(page);
        enriched.push(normalizeLicense({ ...rowLicense, ...detail, folioId: rowLicense.folioId }));
      } catch (detailError) {
        enriched.push(normalizeLicense({
          ...rowLicense,
          extractionWarning: `No se pudo cargar detalle: ${detailError.message}`
        }));
      }
    }

    res.json({
      success: true,
      licencias: enriched,
      diagnostics: {
        url: listInfo.url,
        title: listInfo.title,
        rowCount: listInfo.rowCount,
        htmlLength: listInfo.htmlLength
      }
    });
  } catch (error) {
    console.error('[imed/licencias]', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.post('/api/imed/tramitar', async (req, res) => {
  res.status(501).json({
    success: false,
    error: 'Endpoint pendiente: hay que capturar el formulario real de iMed con Puppeteer antes de tramitar.'
  });
});

function assertCredentials() {
  if (!IMED_RUT || !IMED_PASS) {
    throw new Error('IMED_RUT y IMED_PASS no configurados en variables de entorno');
  }
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
}

async function configurePage(page) {
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(45000);
  await page.setViewport({ width: 1365, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
}

async function loginImed(page) {
  const loginUrl = `${IMED_BASE_URL}/sesiones/nueva/rol:empleador`;
  console.log('[imed] login page');
  await page.goto(loginUrl, { waitUntil: 'networkidle2' });

  const rutSelector = await firstSelector(page, [
    'input[name="data[Sesion][rut]"]',
    'input[name="user[rut]"]',
    'input[name*="[rut]"]',
    'input[name="rut"]'
  ]);
  const passSelector = await firstSelector(page, [
    'input[name="data[Sesion][password]"]',
    'input[name="user[password]"]',
    'input[type="password"]'
  ]);

  if (!rutSelector || !passSelector) {
    const title = await page.title();
    throw new Error(`No se encontraron campos de login iMed. title=${title}`);
  }

  await page.click(rutSelector, { clickCount: 3 });
  await page.type(rutSelector, IMED_RUT, { delay: 15 });
  await page.click(passSelector, { clickCount: 3 });
  await page.type(passSelector, IMED_PASS, { delay: 15 });

  const submitSelector = await firstSelector(page, [
    'input[type="image"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button'
  ]);
  if (!submitSelector) throw new Error('No se encontró botón de ingreso iMed');

  console.log('[imed] submit login');
  await Promise.all([
    page.click(submitSelector),
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null)
  ]);

  const bodyText = await getBodyText(page);
  if (/contrase|credencial|inv[aá]lid|caducad/i.test(bodyText)) {
    throw new Error('iMed rechazó login o devolvió sesión caducada');
  }
}

async function loadPendingLicenses(page) {
  const url = `${IMED_BASE_URL}/licencias/para_tramitar/`;
  console.log('[imed] pending licenses');
  await page.goto(url, { waitUntil: 'networkidle2' });
  await waitForBodyText(page);

  const title = await page.title();
  const html = await page.content();
  const licencias = await extractRowsFromPage(page);

  return {
    url: page.url(),
    title,
    htmlLength: html.length,
    rowCount: licencias.length,
    licencias
  };
}

async function extractRowsFromPage(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizeRut = (value) => clean(value).replace(/\./g, '').toUpperCase();
    const rutRegex = /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/;
    const dateRegex = /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/g;

    const linkToId = (link) => {
      if (!link) return '';
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/licencias\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    };

    const rows = Array.from(document.querySelectorAll('tr'));
    const licenses = [];

    rows.forEach((row) => {
      const rowText = clean(row.innerText);
      if (!rowText || !rutRegex.test(rowText)) return;

      const cells = Array.from(row.querySelectorAll('td')).map((td) => clean(td.innerText));
      const link = row.querySelector('a[href*="/licencias/"]');
      const dates = rowText.match(dateRegex) || [];
      const rutMatch = rowText.match(rutRegex);
      const folioCandidate = cells.find((cell) => /\d{6,}/.test(cell) && !rutRegex.test(cell)) ||
        clean(link && link.innerText) ||
        '';
      const daysCandidate = cells.find((cell) => /^\d{1,3}$/.test(cell));

      licenses.push({
        portal: 'imed',
        folio: folioCandidate,
        folioId: linkToId(link),
        rut: rutMatch ? normalizeRut(rutMatch[0]) : '',
        nombre: cells.find((cell) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(cell) && !/licencia|folio|rut/i.test(cell)) || '',
        fechaInicio: dates[0] || '',
        fechaFin: dates[1] || '',
        diasReposo: daysCandidate ? parseInt(daysCandidate, 10) : 0,
        raw: { cells, rowText, href: link ? link.href : '' }
      });
    });

    return licenses;
  });
}

async function extractDetailFromPage(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizeRut = (value) => clean(value).replace(/\./g, '').toUpperCase();
    const lines = document.body.innerText.split(/\n+/).map(clean).filter(Boolean);

    const valueAfterLabel = (labelRegex) => {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!labelRegex.test(line)) continue;
        const inline = line.split(':').slice(1).join(':').trim();
        if (inline) return inline;
        return lines[i + 1] || '';
      }
      return '';
    };

    const allText = clean(document.body.innerText);
    const rutMatch = allText.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/);
    const dates = allText.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/g) || [];
    const diasLine = valueAfterLabel(/d[ií]as/i);
    const diasMatch = diasLine.match(/^\d{1,3}$/) ||
      allText.match(/d[ií]as(?:\s+de)?(?:\s+reposo)?[^0-9]{0,30}(\d{1,3})/i);
    const folioLine = valueAfterLabel(/folio/i);

    return {
      folio: folioLine || '',
      rut: rutMatch ? normalizeRut(rutMatch[0]) : '',
      nombre: valueAfterLabel(/nombre/i) || valueAfterLabel(/paciente/i),
      fechaInicio: valueAfterLabel(/inicio.*reposo|desde/i) || dates[0] || '',
      fechaFin: valueAfterLabel(/fin.*reposo|hasta/i) || dates[1] || '',
      diasReposo: diasMatch ? parseInt(diasMatch[1] || diasMatch[0], 10) : 0,
      tipoLicencia: valueAfterLabel(/tipo.*licencia/i),
      raw: { title: document.title, textSample: allText.substring(0, 2000) }
    };
  });
}

function normalizeLicense(lic) {
  const fechaInicio = normalizeDate(lic.fechaInicio);
  const fechaFin = normalizeDate(lic.fechaFin);

  return {
    portal: 'imed',
    folio: cleanText(lic.folio),
    folioId: cleanText(lic.folioId || lic.folio),
    rut: normalizeRut(lic.rut),
    nombre: cleanText(lic.nombre),
    fechaInicio,
    fechaFin,
    diasReposo: Number.parseInt(lic.diasReposo, 10) || calculateDays(fechaInicio, fechaFin) || 0,
    tipoLicencia: cleanText(lic.tipoLicencia),
    raw: lic.raw || {},
    extractionWarning: lic.extractionWarning || ''
  };
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) return '';

  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;

  match = text.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (!match) return text;

  return `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${match[3]}`;
}

function calculateDays(start, end) {
  const s = parseDmy(start);
  const e = parseDmy(end);
  if (!s || !e) return 0;
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

function parseDmy(value) {
  const match = cleanText(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function normalizeRut(value) {
  return cleanText(value).replace(/\./g, '').toUpperCase();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function firstSelector(page, selectors) {
  for (const selector of selectors) {
    const found = await page.$(selector);
    if (found) return selector;
  }
  return '';
}

async function waitForBodyText(page) {
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, {
    timeout: 15000
  }).catch(() => null);
}

async function getBodyText(page) {
  return page.evaluate(() => document.body ? document.body.innerText : '');
}

app.listen(PORT, () => {
  console.log(`Proxy iMed ejecutándose en puerto ${PORT}`);
});
