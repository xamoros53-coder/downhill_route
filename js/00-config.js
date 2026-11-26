// 00-config.js — ajustes del despliegue. Es lo único que cambia entre desarrollo y producción.
window.APP_CONFIG = {
  DATOS_BASE: "data",                          // carpeta con las bajadas precalculadas (data/<zona>/indice.json + celdas/)
  BROUTER_URL: "https://brouter.de/brouter",   // TODO producción: tu BRouter propio (p. ej. "/api/route")

  // ---- Búsqueda de lugares. Cada fuente es opcional: deja su URL vacía ("") para desactivarla ----
  // TODO producción: los servidores públicos son solo para uso personal/pruebas. Pon aquí tu servidor o el de un proveedor de pago.
  BUSQUEDA_URL: "https://nominatim.openstreetmap.org/search",   // API compatible con Nominatim (también Geoapify, LocationIQ, MapTiler…)
  BUSQUEDA_PARAMS: {},                                           // parámetros extra, p. ej. { key: "TU_CLAVE" } si el proveedor la pide
  PHOTON_URL: "https://photon.komoot.io/api/",                   // "" para desactivar (el servidor público es solo para pruebas)
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",       // "" para desactivar (límites de uso en comercial)
};

// Versión de este index.html: aparece en la consola y en el título de la pestaña
window.APP_VERSION = "datos-v3-pirineos-es-fr";
console.log("[app] index.html versión", window.APP_VERSION);
document.title = document.title + " · " + window.APP_VERSION;
// Quita service workers y cachés de versiones anteriores (si los hubiera) para ver siempre esta versión
if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => { console.log("[app] service worker eliminado", r.scope); r.unregister(); })).catch(() => {});
if (window.caches) caches.keys().then(ks => ks.forEach(k => { console.log("[app] caché eliminada", k); caches.delete(k); })).catch(() => {});
