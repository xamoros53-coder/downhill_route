# MTB Ride Planner

```
index.html              solo estructura (HTML)
manifest.webmanifest    PWA
css/app.css             estilos
js/                     código; se carga en el ORDEN del nombre (ver abajo)
lib/                    MapLibre (terceros, no se edita)
icons/                  iconos de la app / PWA
data/                   bajadas precalculadas: data/<zona>/indice.json + celdas/ (lo genera tools/generador)
tools/generador/        pipeline OSM -> data/ (no se despliega)
```

## Migrar desde el proyecto antiguo (copia, no borra nada)
- **Windows (PowerShell):** `powershell -ExecutionPolicy Bypass -File .\reorganizar.ps1 -Old "C:\ruta\proyecto\antiguo"`
- **Linux / macOS / Git Bash:** `bash reorganizar.sh /ruta/proyecto/antiguo`

## Probar en local
Desde esta carpeta: `py -m http.server 8000` (Windows) o `python3 -m http.server 8000`, y abre http://localhost:8000.
Sin Python: extensión **Live Server** de VS Code, o `npx serve` si tienes Node.

## Despliegue
Se sube `index.html`, `manifest.webmanifest`, `css/`, `js/`, `lib/`, `icons/` y `data/`. `tools/` no.
Los ajustes de entorno (carpeta de datos, URL de BRouter) están solo en `js/00-config.js`.

## Orden de carga (importante)
Son scripts clásicos que comparten el ámbito global, igual que cuando era un solo archivo.
El prefijo numérico es el orden en `index.html`: **no los reordenes** y añade los nuevos al final
(o al lugar que toque) tanto en el nombre como en `index.html`.

| Archivo | Contenido |
|---|---|
| 00-config | APP_CONFIG (URLs/rutas) y versión |
| routing | BRouter: enlaces entre bajadas, nogos, GPX (antes `ruta.js`) |
| 01-mapa | colores, mapa base OpenFreeMap, satélite PNOA, creación del mapa |
| 02-ubicacion | mi ubicación y ajustes de seguimiento |
| 03-mapa-controles | botón satélite y relieve 3D |
| 04-estado | estado global (bajadas, ruta, perfil) y claves de almacenamiento |
| 05-panel | panel inferior plegable |
| 06-mi-ruta | persistencia, lista de la ruta, ordenar arrastrando |
| 07-popup-punto | pulsación larga en el mapa |
| 08-ui | toast, pasos, helpers (`esc`, `idDe`, `fmtLong`…) |
| 09-bajadas-cache | caché IndexedDB, arranque (`iniciarApp`) |
| 10-bajadas-datos | descarga de celdas e índices |
| 11-bajadas-perfil | perfil completo, capas, selección |
| 12-ficha | ficha y mini perfil de una bajada |
| 13-busqueda | búsqueda de bajadas y de lugares (CartoCiudad) |
| 14-ruta-mapa | dibujar la ruta, marcas de km |
| 15-perfil-altimetria | perfil de altimetría de la ruta |
| 16-generar-ruta | detección de saltos, botón generar, descarga GPX |
| 17-seguir | seguir ruta en vivo |
| 18-gpx-import | importar GPX |
| 19-ajustes | ajustes y limpieza de caché |

Siguiente paso previsto: pasar a módulos ES (`import`/`export`) y añadir `js/api.js` (cuentas, comentarios, reportes).
