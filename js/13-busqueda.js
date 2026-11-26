// 13-busqueda.js (líneas 1780-1899 del index.html original)
// ---- Búsqueda rápida por nombre (mapa) ----
const busquedaWrap = document.getElementById("busquedaWrap");
const btnBuscarToggle = document.getElementById("btnBuscarToggle");
const busquedaPanel = document.getElementById("busquedaPanel");
const busquedaInput = document.getElementById("busquedaInput");
const busquedaResultados = document.getElementById("busquedaResultados");
let textoBusqueda = "";
btnBuscarToggle.addEventListener("click", () => {
  const abrir = !busquedaPanel.classList.contains("abierto");
  busquedaPanel.classList.toggle("abierto", abrir);
  btnBuscarToggle.setAttribute("aria-label", abrir ? "Cerrar búsqueda" : "Buscar bajada o lugar");
  if (abrir) setTimeout(() => busquedaInput.focus(), 30);
  else { busquedaInput.value = ""; textoBusqueda = ""; actualizarBusqueda(); }
});
const norm = t => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");   // sin tildes ni mayúsculas
let seqLugares = 0, marcadorLugar = null;
function cerrarBusqueda() { busquedaPanel.classList.remove("abierto"); busquedaInput.blur(); }
function actualizarBusqueda() {
  seqLugares++;                                   // invalida una búsqueda de lugares que estuviera en curso
  const texto = busquedaInput.value.trim();
  textoBusqueda = norm(texto);
  busquedaResultados.innerHTML = "";
  if (!textoBusqueda) return;
  const coincidencias = features.filter(f => norm(f.properties.nombre).includes(textoBusqueda));
  // La búsqueda no oculta el resto de las bajadas: solo muestra resultados aquí.
  if (coincidencias.length) {
    const h = document.createElement("div"); h.className = "res-grupo"; h.textContent = "Bajadas"; busquedaResultados.appendChild(h);
    coincidencias.slice(0, 8).forEach(f => {
      const b = document.createElement("button"); b.type = "button"; b.className = "resultado-busqueda";
      b.textContent = f.properties.nombre || "Bajada sin nombre";
      b.addEventListener("click", () => { seleccionar(idDe(f), { fit: true }); cerrarBusqueda(); });
      busquedaResultados.appendChild(b);
    });
  }
  // Los lugares se buscan al pulsar Intro o este botón (una petición por búsqueda, no por cada letra)
  const zona = document.createElement("div");
  const bl = document.createElement("button"); bl.type = "button"; bl.className = "resultado-busqueda btn-lugar";
  bl.textContent = `🔎 Buscar «${texto}» como lugar`;
  bl.addEventListener("click", () => buscarLugares(texto, zona));
  zona.appendChild(bl);
  busquedaResultados.appendChild(zona);
  if (!coincidencias.length) {
    const v = document.createElement("div"); v.className = "resultado-vacio"; v.textContent = "Ninguna bajada con ese nombre."; busquedaResultados.insertBefore(v, zona);
  }
}
// ---- Búsqueda de lugares: varias fuentes en paralelo (Nominatim + Photon + Overpass), fusionadas y ordenadas ----
//  · Nominatim (OSM): población, valles, picos… buena con nombres completos
//  · Photon (OSM, Komoot): tolera erratas y nombres parciales («balandrau», «ordino arcal»…)
//  · Overpass (OSM): consulta directa de picos, collados y refugios por nombre dentro del Pirineo
const NOMINATIM_URL = APP_CONFIG.BUSQUEDA_URL ?? "";      // las URLs se definen en js/00-config.js
const PHOTON_URL = APP_CONFIG.PHOTON_URL ?? "";
const OVERPASS_URL = APP_CONFIG.OVERPASS_URL ?? "";
const PAISES_BUSQUEDA = ["es", "fr", "ad"];
const BBOX_MONTE = { s: 41.8, w: -2.4, n: 43.7, e: 3.4 };   // zona donde Overpass busca picos/collados/refugios; amplía si sales del Pirineo
const TIPOS_LUGAR = {   // tipo OSM → [etiqueta, zoom]
  peak: ["Pico", 14], volcano: ["Volcán", 14], saddle: ["Collado", 14], mountain_pass: ["Puerto de montaña", 14], alpine_hut: ["Refugio", 15],
  valley: ["Valle", 13], lake: ["Lago", 14], hamlet: ["Aldea", 15], village: ["Pueblo", 14], suburb: ["Barrio", 14], town: ["Localidad", 13],
  city: ["Ciudad", 12], municipality: ["Municipio", 12], administrative: ["Zona administrativa", 11], county: ["Comarca", 10], state: ["Región", 8]
};
const TIPOS_MONTE = ["peak", "volcano", "saddle", "mountain_pass", "alpine_hut"];

async function pedirJson(url, opciones, ms) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opciones, signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fuenteNominatim(texto) {
  const b = map.getBounds();
  const par = { q: texto, format: "jsonv2", limit: 10, extratags: 1, "accept-language": "es,fr,ca", countrycodes: PAISES_BUSQUEDA.join(","),
    viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(","),   // sesga hacia lo que se ve; no excluye lo de fuera
    ...(APP_CONFIG.BUSQUEDA_PARAMS || {}) };
  const lista = await pedirJson(NOMINATIM_URL + "?" + new URLSearchParams(par), {}, 8000);
  return lista.map(p => {
    const partes = String(p.display_name || "").split(", ");
    return { nombre: p.name || partes[0], tipo: p.type, donde: partes.slice(1, 4).join(", "), lat: Number(p.lat), lng: Number(p.lon),
      ele: parseFloat(p.extratags && p.extratags.ele) || null };
  });
}

async function fuentePhoton(texto) {
  const c = map.getCenter();
  const par = { q: texto, limit: 12, lat: c.lat.toFixed(4), lon: c.lng.toFixed(4) };   // lat/lon = sesgo hacia el centro del mapa
  const j = await pedirJson(PHOTON_URL + "?" + new URLSearchParams(par), {}, 8000);
  return (j.features || [])
    .filter(f => f.properties && f.properties.name && PAISES_BUSQUEDA.includes(String(f.properties.countrycode || "").toLowerCase()))
    .map(f => {
      const p = f.properties;
      return { nombre: p.name, tipo: p.osm_value, donde: [p.city || p.county, p.state, p.country].filter((x, i, a) => x && a.indexOf(x) === i).join(", "),
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], ele: null };
    });
}

// Regex tolerante a tildes y mayúsculas para Overpass (a → [aàáâä], etc.). Solo letras, números, espacio, guion y apóstrofo.
function regexTolerante(texto) {
  const clases = { a: "aàáâäã", e: "eèéêë", i: "iìíîï", o: "oòóôöõ", u: "uùúûü", n: "nñ", c: "cç" };
  const limpio = norm(texto).replace(/[^\p{L}\p{N} '\-]/gu, "").trim();
  return [...limpio].map(ch => clases[ch] ? "[" + clases[ch] + "]" : ch).join("");
}
async function fuenteOverpass(texto) {
  const re = regexTolerante(texto);
  if (re.length < 3) return [];
  const bb = `(${BBOX_MONTE.s},${BBOX_MONTE.w},${BBOX_MONTE.n},${BBOX_MONTE.e})`;
  const nom = `[~"^(name|alt_name|old_name|name:ca|name:es|name:fr|name:oc)$"~"${re}",i]`;
  const q = `[out:json][timeout:12];(node["natural"~"^(peak|saddle|volcano)$"]${nom}${bb};node["mountain_pass"="yes"]${nom}${bb};node["tourism"="alpine_hut"]${nom}${bb};);out body 25;`;
  const j = await pedirJson(OVERPASS_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) }, 14000);
  return (j.elements || []).map(e => {
    const t = e.tags || {};
    const tipo = t.natural === "peak" || t.natural === "saddle" || t.natural === "volcano" ? t.natural : t.mountain_pass === "yes" ? "mountain_pass" : t.tourism;
    return { nombre: t.name || t["name:ca"] || t["name:es"] || t["name:fr"] || t.alt_name || "Sin nombre", tipo, donde: "", lat: e.lat, lng: e.lon, ele: parseFloat(t.ele) || null };
  });
}

// Orden: coincidencia exacta > empieza por > palabra completa > contiene; bonus a picos/collados/refugios; penaliza la distancia al centro del mapa
function puntuarLugar(it, q) {
  const n = norm(it.nombre);
  let s = 0;
  if (n === q) s += 100;
  else if (n.startsWith(q)) s += 60;
  else if (n.split(/[\s'’\-]+/).includes(q)) s += 50;
  else if (n.includes(q)) s += 30;
  if (TIPOS_MONTE.includes(it.tipo)) s += 15;
  const c = map.getCenter();
  s -= Math.min(25, haversine([c.lat, c.lng], [it.lat, it.lng]) / 1000 / 20);
  return s;
}
function fusionarLugares(lista, q) {
  const validos = lista.filter(it => isFinite(it.lat) && isFinite(it.lng) && (it.lat || it.lng) && it.nombre);
  validos.forEach(it => { it.puntos = puntuarLugar(it, q); });
  validos.sort((a, b) => b.puntos - a.puntos);
  const fuera = [];
  for (const it of validos) {
    const n = norm(it.nombre);
    // mismo sitio devuelto por varias fuentes (a menos de 400 m y un nombre contiene al otro)
    const dup = fuera.find(o => { const m = norm(o.nombre); return (m.includes(n) || n.includes(m)) && haversine([o.lat, o.lng], [it.lat, it.lng]) < 400; });
    if (dup) { if (!dup.ele && it.ele) dup.ele = it.ele; if (!dup.donde && it.donde) dup.donde = it.donde; if (TIPOS_LUGAR[it.tipo] && !TIPOS_LUGAR[dup.tipo]) dup.tipo = it.tipo; continue; }
    fuera.push(it);
  }
  return fuera.slice(0, 12);
}

async function buscarLugares(texto, zona) {
  const mi = ++seqLugares, q = norm(texto);
  const fuentes = [[NOMINATIM_URL, fuenteNominatim], [PHOTON_URL, fuentePhoton], [OVERPASS_URL, fuenteOverpass]].filter(([url]) => url).map(([, f]) => f);   // solo las fuentes con URL en la config
  if (!fuentes.length) { zona.innerHTML = '<div class="resultado-vacio">La búsqueda de lugares no está configurada.</div>'; return; }
  let todos = [], pendientes = fuentes.length, fallos = 0;
  zona.innerHTML = '<div class="resultado-vacio">Buscando lugares…</div>';
  function pintar() {   // se repinta cada vez que llega una fuente, para ver resultados sin esperar a la más lenta
    if (mi !== seqLugares) return;
    const lista = fusionarLugares(todos, q);
    zona.innerHTML = "";
    const h = document.createElement("div"); h.className = "res-grupo"; h.textContent = "Lugares"; zona.appendChild(h);
    lista.forEach(p => {
      const [etiqueta, zoom] = TIPOS_LUGAR[p.tipo] || [String(p.tipo || "Lugar").replace(/_/g, " "), 13];
      const b = document.createElement("button"); b.type = "button"; b.className = "resultado-busqueda";
      const detalle = [etiqueta + (p.ele ? ` · ${Math.round(p.ele)} m` : ""), p.donde].filter(Boolean).join(" · ");
      b.innerHTML = `${esc(p.nombre)}<small>${esc(detalle)}</small>`;
      b.addEventListener("click", () => {
        cerrarBusqueda();
        map.flyTo({ center: [p.lng, p.lat], zoom, duration: 700 });
        if (marcadorLugar) marcadorLugar.remove();
        const mk = marcadorLugar = new maplibregl.Marker({ color: "#d62f2f" }).setLngLat([p.lng, p.lat]).addTo(map);
        setTimeout(() => { mk.remove(); if (marcadorLugar === mk) marcadorLugar = null; }, 20000);
      });
      zona.appendChild(b);
    });
    if (pendientes > 0) zona.insertAdjacentHTML("beforeend", '<div class="resultado-vacio">Buscando en más fuentes…</div>');
    else if (!lista.length) zona.insertAdjacentHTML("beforeend", `<div class="resultado-vacio">${fallos === fuentes.length ? "No se pudo buscar el lugar. Revisa la conexión." : "No se ha encontrado ningún lugar."}</div>`);
  }
  fuentes.forEach(f => {
    f(texto).then(r => { if (mi === seqLugares) todos = todos.concat(r); })
      .catch(e => { fallos++; console.warn("[búsqueda]", f.name, e); })
      .finally(() => { pendientes--; pintar(); });
  });
}
busquedaInput.addEventListener("input", actualizarBusqueda);
busquedaInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const bl = busquedaResultados.querySelector(".btn-lugar"); if (bl) bl.click();
});

