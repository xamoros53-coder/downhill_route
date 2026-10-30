// ruta.js — generación de GPX con enlaces BRouter evitando subir por bajadas
// Expone window.generarRutaGPX y window.descargarGPX para el index.html
//
// Uso:
//   generarRutaGPX(seleccion, puntoInicio, puntoFin, perfil, onEstado, todasLasBajadas)
//   - seleccion:       features (GeoJSON) de las bajadas elegidas, en orden
//   - puntoInicio/Fin: [lat, lon] o null
//   - todasLasBajadas: features de TODAS las bajadas descargadas (para bloquear la subida por ellas)

const BROUTER_URL = "https://brouter.de/brouter";
const MAX_SALTO_AVISO_M = 80;
const AVISO_ENLACE_LARGO_KM = 20;
const MIN_ENLACE_M = 30; // enlaces más cortos se saltan (BRouter no aporta nada)

// --- Bloqueo de subidas por bajadas (nogos) ---
const UMBRAL_CAIDA_NO_SUBIR_M = 15; // bajadas con menos caída que esto: se puede subir por ellas
const RADIO_NOGO_M = 20;            // radio de cada círculo bloqueado
const PASO_NOGO_M = 30;             // un nogo cada 30 m (menor que 2*radio => círculos solapados)
const MAX_NOGOS = 150;              // límite para que la URL no sea enorme
const MARGEN_ENLACE_GRADOS = 0.015; // ~1.5 km de margen alrededor del enlace
const DIST_LIBRE_EXTREMOS_M = 40;   // no bloquear inicio/fin del enlace

function haversine(a, b) {
  const R = 6371000;
  const p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
  const dp = p2 - p1;
  const dl = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function llamarBRouter(lon1, lat1, lon2, lat2, perfil, nogoList = []) {
  const lonlats = `${lon1},${lat1}|${lon2},${lat2}`;
  let url = `${BROUTER_URL}?lonlats=${encodeURIComponent(lonlats)}&profile=${encodeURIComponent(perfil)}&format=gpx`;

  if (nogoList && nogoList.length > 0) {
    // El parámetro de BRouter es "nogos" (no "nogo"): lon,lat,radio separados por |
    const s = nogoList.map(n => `${n.lon.toFixed(5)},${n.lat.toFixed(5)},${RADIO_NOGO_M}`).join("|");
    url += `&nogos=${encodeURIComponent(s)}`;
  }

  const r = await fetch(url);
  if (!r.ok) throw new Error(`BRouter respondió ${r.status}`);
  return await r.text();
}

function parsearGPXPuntos(gpxTexto) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxTexto, "application/xml");
  const pts = [];
  const trkpts = doc.getElementsByTagName("trkpt");
  for (let i = 0; i < trkpts.length; i++) {
    const el = trkpts[i];
    const lat = parseFloat(el.getAttribute("lat"));
    const lon = parseFloat(el.getAttribute("lon"));
    const eleEl = el.getElementsByTagName("ele")[0];
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    pts.push([lat, lon, ele]);
  }
  return pts;
}

function puntoInicioBajada(f) {
  const p = f.properties;
  if (p.inicio) return [p.inicio[1], p.inicio[0]];
  const c = f.geometry.coordinates[0];
  return [c[1], c[0]];
}
function puntoFinBajada(f) {
  const p = f.properties;
  if (p.fin) return [p.fin[1], p.fin[0]];
  const c = f.geometry.coordinates[f.geometry.coordinates.length - 1];
  return [c[1], c[0]];
}
function geometriaBajada(f) {
  return f.geometry.coordinates.map(c => [c[1], c[0], c.length > 2 ? c[2] : null]);
}

/**
 * Puntos "nogo" a lo largo de una bajada (uno cada PASO_NOGO_M metros).
 * Solo se generan si la bajada tiene una caída superior al umbral:
 * las casi llanas se pueden subir.
 */
function caidaBajadaM(f) {
  const v = Number(f.properties.caida_m);
  if (Number.isFinite(v)) return v;
  // Sin caida_m: se estima con la elevación del primer y último punto, si existe
  const c = f.geometry.coordinates;
  const e0 = c[0] && c[0][2], e1 = c[c.length - 1] && c[c.length - 1][2];
  return (Number.isFinite(e0) && Number.isFinite(e1)) ? e0 - e1 : 0;
}

function obtenerNogosDeBajada(f) {
  if (caidaBajadaM(f) <= UMBRAL_CAIDA_NO_SUBIR_M) return [];

  const c = f.geometry.coordinates; // [lon, lat, ele]
  if (!c || c.length === 0) return [];

  // Se interpola a lo largo de cada tramo para que no queden huecos
  // aunque la geometría tenga pocos vértices.
  const nogos = [{ lat: c[0][1], lon: c[0][0] }];
  let acum = 0;
  for (let i = 1; i < c.length; i++) {
    const a = [c[i - 1][1], c[i - 1][0]], b = [c[i][1], c[i][0]];
    const d = haversine(a, b);
    if (d === 0) continue;
    let pos = PASO_NOGO_M - acum;      // distancia hasta el siguiente nogo dentro de este tramo
    while (pos <= d) {
      const t = pos / d;
      nogos.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t });
      pos += PASO_NOGO_M;
    }
    acum = d - (pos - PASO_NOGO_M);
  }
  const ult = c[c.length - 1];
  nogos.push({ lat: ult[1], lon: ult[0] });
  return nogos;
}

/**
 * Filtra los nogos que importan para un enlace concreto:
 * solo los cercanos a la zona del enlace y sin tapar su inicio ni su fin.
 */
function nogosParaEnlace(todos, desde, hasta) {
  const m = MARGEN_ENLACE_GRADOS;
  const minLat = Math.min(desde[0], hasta[0]) - m, maxLat = Math.max(desde[0], hasta[0]) + m;
  const minLon = Math.min(desde[1], hasta[1]) - m, maxLon = Math.max(desde[1], hasta[1]) + m;
  return todos
    .filter(n => n.lat > minLat && n.lat < maxLat && n.lon > minLon && n.lon < maxLon)
    .filter(n => {
      const p = [n.lat, n.lon];
      return haversine(p, desde) > DIST_LIBRE_EXTREMOS_M && haversine(p, hasta) > DIST_LIBRE_EXTREMOS_M;
    })
    .slice(0, MAX_NOGOS);
}

function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function construirGPX(puntos, waypoints) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="ride-planner-piloto" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata><name>Ruta Ride Planner</name></metadata>'
  ];
  for (const w of waypoints) {
    lines.push(`  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">`);
    lines.push(`    <name>${esc(w.name)}</name>`);
    lines.push('  </wpt>');
  }
  lines.push('  <trk>');
  lines.push('    <name>Ruta</name>');
  lines.push('    <trkseg>');
  for (const [lat, lon, ele] of puntos) {
    lines.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">`);
    if (ele !== null && ele !== undefined) lines.push(`        <ele>${ele.toFixed(1)}</ele>`);
    lines.push('      </trkpt>');
  }
  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join("\n");
}

function descargarGPX(gpx, nombre) {
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function longitudM(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine([pts[i - 1][0], pts[i - 1][1]], [pts[i][0], pts[i][1]]);
  return d;
}

function calcularEstadisticas(segmentos) {
  let distM = 0, distBajadasM = 0, sube = 0, baja = 0, conEle = 0, total = 0, eleAnt = null;
  for (const s of segmentos) {
    const d = longitudM(s.puntos);
    distM += d;
    eleAnt = null;
    if (s.tipo === "bajada") distBajadasM += d;
    for (const p of s.puntos) {
      total++;
      if (p[2] === null || p[2] === undefined) continue;
      conEle++;
      if (eleAnt !== null) { const dz = p[2] - eleAnt; if (dz > 0) sube += dz; else baja -= dz; }
      eleAnt = p[2];
    }
  }
  const hayEle = total > 0 && conEle / total > 0.9;
  return {
    distM, distBajadasM, distEnlacesM: distM - distBajadasM,
    sube: hayEle ? Math.round(sube) : null,
    baja: hayEle ? Math.round(baja) : null
  };
}

async function generarRutaGPX(seleccion, puntoInicio, puntoFin, perfil, onEstado, todasLasBajadas) {
  // "seleccion" es la lista ordenada de la ruta: bajadas (features GeoJSON)
  // y puntos intermedios ({ punto: true, lat, lon, nombre }).
  const bajadas = seleccion.filter(x => !x.punto);
  if (bajadas.length === 0) throw new Error("No hay bajadas seleccionadas");

  const estado = onEstado || (() => {});
  const segmentos = [];
  const waypoints = [];

  // Nogos de TODAS las bajadas descargadas (si no se pasan, solo las seleccionadas)
  const universo = (todasLasBajadas && todasLasBajadas.length) ? todasLasBajadas : bajadas;
  const nogoGlobal = universo.flatMap(obtenerNogosDeBajada);

  async function enlace(desde, hasta, etiqueta) {
    const d = haversine(desde, hasta);
    if (d < MIN_ENLACE_M) return;
    if (d > AVISO_ENLACE_LARGO_KM * 1000) {
      if (!confirm(`El ${etiqueta} es de ${(d / 1000).toFixed(1)} km. ¿Continuar?`)) {
        throw new Error("Cancelado por el usuario");
      }
    }
    estado(`${etiqueta[0].toUpperCase() + etiqueta.slice(1)} (${Math.round(d)} m)...`);

    let pts;
    let conNogo = true;
    try {
      const nogos = nogosParaEnlace(nogoGlobal, desde, hasta);
      try {
        pts = parsearGPXPuntos(await llamarBRouter(desde[1], desde[0], hasta[1], hasta[0], perfil, nogos));
      } catch (e) {
        // Sin ruta posible evitando las bajadas: reintenta sin restricciones
        console.warn(`Sin ruta con nogos en ${etiqueta}, reintentando sin ellos`, e);
        pts = parsearGPXPuntos(await llamarBRouter(desde[1], desde[0], hasta[1], hasta[0], perfil, []));
        conNogo = false;
      }
    } catch (e) {
      console.warn(`Error en ${etiqueta}:`, e);
      throw new Error(`No se pudo calcular el ${etiqueta}: ` + e.message);
    }

    if (pts.length === 0) throw new Error(`BRouter no devolvió ninguna ruta para el ${etiqueta}`);
    const d0 = haversine(desde, [pts[0][0], pts[0][1]]);
    const d1 = haversine(hasta, [pts[pts.length - 1][0], pts[pts.length - 1][1]]);
    if (d0 > MAX_SALTO_AVISO_M || d1 > MAX_SALTO_AVISO_M) {
      console.warn(`Salto en ${etiqueta}: ${d0.toFixed(0)} m / ${d1.toFixed(0)} m`);
    }
    // conNogo === false => este enlace puede subir por una bajada (no había alternativa)
    segmentos.push({ tipo: "enlace", nombre: etiqueta, puntos: pts, conNogo });
  }

  // Se recorre la lista en orden; "pos" es donde está el ciclista en cada momento
  let pos = null;
  let nEnlace = 0, nBajada = 0;

  if (puntoInicio) {
    pos = puntoInicio;
    waypoints.push({ lat: puntoInicio[0], lon: puntoInicio[1], name: "Inicio ruta" });
  }

  for (const item of seleccion) {
    if (item.punto) {
      const destino = [item.lat, item.lon];
      if (pos) await enlace(pos, destino, pos === puntoInicio ? "enlace inicial" : `enlace ${++nEnlace}`);
      waypoints.push({ lat: item.lat, lon: item.lon, name: item.nombre || "Punto intermedio" });
      pos = destino;
      continue;
    }
    nBajada++;
    const nombre = item.properties.nombre || `Bajada ${nBajada}`;
    const ini = puntoInicioBajada(item);
    if (pos) await enlace(pos, ini, pos === puntoInicio ? "enlace inicial" : `enlace ${++nEnlace}`);
    waypoints.push({ lat: ini[0], lon: ini[1], name: `Inicio ${nombre}` });
    segmentos.push({ tipo: "bajada", nombre, puntos: geometriaBajada(item) });
    estado(`Bajada ${nBajada}/${bajadas.length}: ${nombre}`);
    pos = puntoFinBajada(item);
  }

  if (puntoFin && pos) {
    await enlace(pos, puntoFin, "enlace final");
    waypoints.push({ lat: puntoFin[0], lon: puntoFin[1], name: "Fin ruta" });
  }

  estado("Generando GPX...");
  const puntos = segmentos.flatMap(s => s.puntos);
  return { gpx: construirGPX(puntos, waypoints), segmentos, stats: calcularEstadisticas(segmentos) };
}

window.generarRutaGPX = generarRutaGPX;
window.descargarGPX = descargarGPX;
