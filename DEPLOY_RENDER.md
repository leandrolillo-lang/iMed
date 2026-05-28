# Desplegar Proxy iMed en Render

## Paso 1: Crear repositorio GitHub

1. Crea un repositorio público en GitHub
2. Copia estos 2 archivos al repositorio:
   - `proxy-imed.js`
   - `package.json`

3. Commit y push:
```bash
git add .
git commit -m "Initial proxy setup"
git push origin main
```

## Paso 2: Desplegar en Render.com

1. Ve a [Render.com](https://render.com)
2. Haz login con GitHub
3. Click **New** → **Web Service**
4. Selecciona tu repositorio
5. Configura:
   - **Name**: `proxy-imed`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Runtime**: Node
   - **Plan**: Free

6. Click **Environment**
7. Agrega variables de entorno:
   ```
   IMED_RUT = 76244049-0
   IMED_PASS = tu_contraseña
   ```

8. Click **Deploy**

Espera 3-5 minutos. Render te dará una URL como:
```
https://proxy-imed-xxxxx.onrender.com
```

## Paso 3: Actualizar Code.gs

En Google Apps Script, añade esta variable de configuración:

```javascript
var PROXY_IMED_URL = "https://proxy-imed-xxxxx.onrender.com"; // Tu URL de Render
```

Luego crea esta función en Code.gs:

```javascript
function getImedPendientesViaProxy(session) {
  var url = PROXY_IMED_URL + "/api/imed/licencias";
  var resp = UrlFetchApp.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    payload: JSON.stringify({}),
    muteHttpExceptions: true
  });
  
  var code = resp.getResponseCode();
  Logger.log("Proxy HTTP " + code);
  
  if (code !== 200) {
    Logger.log("Error en proxy: " + resp.getContentText());
    return [];
  }
  
  var result = JSON.parse(resp.getContentText());
  if (!result.success || !result.licencias) {
    Logger.log("Proxy error: " + result.error);
    return [];
  }
  
  // Convertir respuesta del proxy al formato esperado
  return result.licencias.map(function(lic) {
    return {
      portal: "imed",
      folio: lic.folio,
      rut: lic.rut,
      nombre: lic.nombre,
      fechaInicio: "",
      diasReposo: 0
    };
  });
}
```

## Paso 4: Probar

En Google Apps Script:
1. Crea una función de test:
```javascript
function testProxyImed() {
  var licencias = getImedPendientesViaProxy();
  Logger.log("Licencias desde proxy: " + licencias.length);
  licencias.forEach(function(l) {
    Logger.log("  " + JSON.stringify(l));
  });
}
```

2. Ejecuta `testProxyImed()`
3. Verifica los logs

## Notas Importantes

- El proxy tardará **30-60 segundos** en responder (Puppeteer tarda en cargar el navegador)
- Render pone los servicios en sleep después de 15 min sin actividad
- En la versión Free, reinicia cada hora
- Para uso en producción, considera Plan pagado ($7/mes)

## Troubleshooting

Si no funciona:
1. Ve a Render dashboard y revisa los logs
2. Verifica que IMED_RUT y IMED_PASS estén correctos
3. Intenta `/health` en el navegador para verificar que el proxy está activo
4. Si está en sleep, haz una solicitud para "despertarlo"
