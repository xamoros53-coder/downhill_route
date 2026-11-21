// 00-config.js — ajustes del despliegue. Es lo único que cambia entre desarrollo y producción.
window.APP_CONFIG = {
  DATOS_BASE: "data",                          // carpeta con las bajadas precalculadas (data/<zona>/indice.json + celdas/)
  BROUTER_URL: "https://brouter.de/brouter",   // TODO producción: tu BRouter propio (p. ej. "/api/route")
};

// Versión de este index.html: aparece en la consola y en el título de la pestaña
window.APP_VERSION = "datos-v2-cataluna";
console.log("[app] index.html versión", window.APP_VERSION);
document.title = document.title + " · " + window.APP_VERSION;
// Quita service workers y cachés de versiones anteriores (si los hubiera) para ver siempre esta versión
if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => { console.log("[app] service worker eliminado", r.scope); r.unregister(); })).catch(() => {});
if (window.caches) caches.keys().then(ks => ks.forEach(k => { console.log("[app] caché eliminada", k); caches.delete(k); })).catch(() => {});
