// sw.js — service worker: permite abrir la app sin cobertura.
//  · App (HTML, JS, CSS, librerías): primero red (con 4 s de margen) y, si no hay cobertura, la última copia guardada.
//  · Bajadas (data/): se sirven al instante desde la copia y se actualizan en segundo plano.
//  · Mapa base (OpenFreeMap) y relieve (AWS Terrain Tiles): lo que ya has visto queda guardado (tope de trozos).
//  · Satélite, rutas (BRouter), búsqueda y demás servicios: siempre por red; sin cobertura no funcionan.
const VERSION = "v1";
const CACHE_APP = "ride-app-" + VERSION;
const CACHE_DATOS = "ride-datos-v1";
const CACHE_MAPA = "ride-mapa-v1";
const MAX_TROZOS_MAPA = 1500;
const ESPERA_RED_MS = 4000;

const PRECARGA = [
  "./", "./index.html", "./manifest.webmanifest", "./css/app.css",
  "./icons/favicon-64.png", "./icons/icon-192.png",
  "./lib/maplibre-gl.css", "./lib/maplibre-gl.js", "./lib/maplibre-contour.min.js",
  "./js/00-config.js", "./js/routing.js",
  "./js/01-mapa.js", "./js/02-ubicacion.js", "./js/03-mapa-controles.js", "./js/04-estado.js", "./js/05-panel.js",
  "./js/06-mi-ruta.js", "./js/07-popup-punto.js", "./js/08-ui.js", "./js/09-bajadas-cache.js", "./js/10-bajadas-datos.js",
  "./js/11-bajadas-perfil.js", "./js/12-ficha.js", "./js/13-busqueda.js", "./js/14-ruta-mapa.js", "./js/15-perfil-altimetria.js",
  "./js/16-generar-ruta.js", "./js/17-seguir.js", "./js/18-gpx-import.js", "./js/19-ajustes.js", "./js/20-diseno.js"
];

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP);
    // Uno a uno: si falta algún archivo (p. ej. un icono) no se estropea la instalación
    await Promise.allSettled(PRECARGA.map(u => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k.startsWith("ride-app-") && k !== CACHE_APP).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function guardable(r) { return r && r.ok && (r.type === "basic" || r.type === "cors"); }

let puestas = 0;
async function recortar(cache, max) {
  if (++puestas % 50) return;   // se comprueba cada 50 trozos nuevos
  const ks = await cache.keys();
  for (let i = 0; i < ks.length - max; i++) await cache.delete(ks[i]);   // los más antiguos primero
}

// Primero red; si tarda más de ESPERA_RED_MS o falla, la copia guardada
async function redPrimero(req, nombre) {
  const cache = await caches.open(nombre);
  const red = fetch(req).then(r => { if (guardable(r)) cache.put(req, r.clone()); return r; });
  try {
    return await Promise.race([red, new Promise((_, no) => setTimeout(() => no(new Error("espera")), ESPERA_RED_MS))]);
  } catch (e) {
    const c = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
    if (c) { red.catch(() => {}); return c; }
    if (req.mode === "navigate") { const i = await cache.match("./index.html"); if (i) { red.catch(() => {}); return i; } }
    return red;   // no hay copia: se espera a la red
  }
}

// Copia al instante y se actualiza en segundo plano
async function copiaYActualiza(req, nombre) {
  const cache = await caches.open(nombre);
  const c = await cache.match(req);
  const red = fetch(req).then(r => { if (guardable(r)) cache.put(req, r.clone()); return r; });
  if (c) { red.catch(() => {}); return c; }
  return red;
}

// Copia guardada si existe; si no, red y se guarda (con tope)
async function copiaPrimero(req, nombre, max) {
  const cache = await caches.open(nombre);
  const c = await cache.match(req);
  if (c) return c;
  const r = await fetch(req);
  if (guardable(r)) { cache.put(req, r.clone()); recortar(cache, max); }
  return r;
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.includes("/data/")) ev.respondWith(copiaYActualiza(req, CACHE_DATOS));
    else ev.respondWith(redPrimero(req, CACHE_APP));
    return;
  }

  // Mapa base OpenFreeMap: el estilo y el índice de teselas cambian con el tiempo (primero red); teselas, fuentes e iconos se guardan
  if (url.hostname === "tiles.openfreemap.org") {
    const cambiante = url.pathname.startsWith("/styles/") || url.pathname === "/planet" || url.pathname.endsWith(".json");
    ev.respondWith(cambiante ? redPrimero(req, CACHE_MAPA) : copiaPrimero(req, CACHE_MAPA, MAX_TROZOS_MAPA));
    return;
  }
  // Relieve (sombreado, curvas de nivel y 3D)
  if (url.hostname === "s3.amazonaws.com" && url.pathname.startsWith("/elevation-tiles-prod/")) {
    ev.respondWith(copiaPrimero(req, CACHE_MAPA, MAX_TROZOS_MAPA));
    return;
  }
  // Todo lo demás (satélite, BRouter, búsqueda…): sin tocar
});
