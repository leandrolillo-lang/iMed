const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Credenciales desde variables de entorno
const IMED_RUT = process.env.IMED_RUT || '';
const IMED_PASS = process.env.IMED_PASS || '';

// Configurar el directorio de cach√© de Puppeteer
const setupPuppeteerCache = () => {
  // Intentar usar el directorio cach√© por defecto, pero si no existe o no es accesible,
  // usar /tmp como alternativa
  const defaultCacheDir = path.join(os.homedir(), '.cache', 'puppeteer');
  const tmpCacheDir = path.join('/tmp', 'puppeteer-cache');

  let cacheDir = process.env.PUPPETEER_CACHE_DIR;

  if (!cacheDir) {
    // Intentar usar el directorio por defecto
    try {
      if (!fs.existsSync(defaultCacheDir)) {
        fs.mkdirSync(defaultCacheDir, { recursive: true });
      }
      cacheDir = defaultCacheDir;
    } catch (e) {
      // Si falla, usar /tmp
      console.log('No se puede escribir en directorio por defecto, usando /tmp');
      try {
        if (!fs.existsSync(tmpCacheDir)) {
          fs.mkdirSync(tmpCacheDir, { recursive: true });
        }
        cacheDir = tmpCacheDir;
      } catch (e2) {
        console.log('Error creando directorios de cach√©:', e2.message);
        cacheDir = tmpCacheDir;
      }
    }
  }

  process.env.PUPPETEER_CACHE_DIR = cacheDir;
  console.log('Directorio de cach√© de Puppeteer:', cacheDir);
  return cacheDir;
};

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.post('/api/imed/licencias', async (req, res) => {
  let browser;
  try {
    // Validar credenciales
    if (!IMED_RUT || !IMED_PASS) {
      return res.status(400).json({ error: 'IMED_RUT y IMED_PASS no configurados' });
    }

    // Configurar cach√©
    const cacheDir = setupPuppeteerCache();

    // Iniciar navegador
    console.log('Lanzando Puppeteer...');

    // Opciones para Puppeteer
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions'
      ]
    };

    // Si se proporciona una ruta ejecutable, usarla
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log('Usando Chrome en:', launchOptions.executablePath);
    }

    try {
      browser = await puppeteer.launch(launchOptions);
    } catch (puppeteerError) {
      console.error('Error al lanzar Puppeteer:', puppeteerError.message);

      // Si el error es por Chrome no encontrado, intentar informaci√≥n adicional
      if (puppeteerError.message.includes('Could not find Chrome')) {
        console.log('Chrome no encontrado. Intentando obtener informaci√≥n del sistema...');
        const BrowserFetcher = puppeteer.BrowserFetcher ? puppeteer.BrowserFetcher : null;
        if (BrowserFetcher) {
          console.log('BrowserFetcher disponible');
        } else {
          console.log('BrowserFetcher no disponible - usar puppeteer.launch solo');
        }
      }

      throw puppeteerError;
    }

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    // 1. Ir a login
    console.log('Navegando a login...');
    await page.goto('https://www.licencia.cl/sesiones/nueva/rol:empleador', {
      waitUntil: 'networkidle2'
    });

    // 2. Esperar y llenar formulario
    console.log('Llenando formulario...');
    await page.waitForSelector('input[name="data[Sesion][rut]"]', { timeout: 10000 });

    // Extraer token
    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="_token"]');
      return input ? input.value : null;
    });

    if (!token) {
      throw new Error('No se pudo obtener _token');
    }

    // Llenar y enviar formulario
    await page.type('input[name="data[Sesion][rut]"]', IMED_RUT);
    await page.type('input[name="data[Sesion][password]"]', IMED_PASS);

    // Hacer submit
    console.log('Enviando login...');
    await Promise.all([
      page.click('input[type="image"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    // 3. Navegar a licencias para tramitar
    console.log('Navegando a licencias para tramitar...');
    await page.goto('https://www.licencia.cl/licencias/para_tramitar/', {
      waitUntil: 'networkidle2'
    });

    // Esperar a que cargue la tabla
    await page.waitForFunction(
      () => document.querySelector('table') || document.body.innerText.includes('128865725'),
      { timeout: 15000 }
    ).catch(() => {
      console.log('Tabla o contenido no encontrado, continuando...');
    });

    // 4. Extraer licencias del HTML
    console.log('Extrayendo licencias...');
    const licencias = await page.evaluate(() => {
      const licencias = [];
      const rows = document.querySelectorAll('table tbody tr');

      if (rows.length === 0) {
        console.log('No hay filas de tabla, buscando estructura alternativa...');
        return null;
      }

      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const folio = cells[1]?.innerText?.trim();
          const rut = cells[2]?.innerText?.trim();
          const nombre = cells[3]?.innerText?.trim();

          if (folio) {
            licencias.push({
              folio,
              rut,
              nombre,
              html: row.outerHTML
            });
          }
        }
      });

      return licencias.length > 0 ? licencias : null;
    });

    if (!licencias) {
      // Intentar extraer del HTML completo
      const pageHTML = await page.content();
      console.log('Devolviendo HTML completo (primeros 1000 chars):');
      console.log(pageHTML.substring(0, 1000));

      return res.json({
        success: true,
        licencias: [],
        html_length: pageHTML.length,
        contains_folio: pageHTML.includes('128865725')
      });
    }

    console.log('Licencias encontradas:', licencias.length);
    res.json({
      success: true,
      licencias: licencias
    });

  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Proxy iMed ejecut√°ndose en puerto ${PORT}`);
  // Configurar cach√© al iniciar
  setupPuppeteerCache();
});
