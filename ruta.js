// ruta.js — generación de GPX con enlaces BRouter (restricciones: no volver por la bajada recién hecha
//            y no subir por las bajadas que todavía quedan por hacer en la ruta)
// Expone window.generarRutaGPX y window.descargarGPX para el index.html
//
// Uso:
//   generarRutaGPX(seleccion, puntoInicio, puntoFin, perfil, onEstado, todasLasBajadas)
//   - seleccion:       features (GeoJSON) de las bajadas elegidas, en orden
//   - puntoInicio/Fin: [lat, lon] o null
//   - todasLasBajadas: ya no se usa (se mantiene en la firma por compatibilidad con index.html)
//   Los nogos se calculan solo con la selección: la bajada previa y las bajadas que quedan por delante.

const BROUTER_URL = "https://brouter.de/brouter";
const MAX_SALTO_AVISO_M = 80;
const AVISO_ENLACE_LARGO_KM = 20;
const MIN_ENLACE_M = 30; // enlaces más cortos se saltan (BRouter no aporta nada)

// --- Única restricción: no volver por la bajada que se acaba de hacer ---
const RADIO_NOGO_M = 20;   // radio de cada círculo bloqueado
const PASO_NOGO_M = 30;    // un nogo cada 30 m (menor que 2*radio => círculos solapados)
const MAX_NOGOS = 180;     // límite total por enlace para que la URL no sea enorme
const MAX_NOGOS_POR_BAJADA = 60;   // máximo de nogos de la bajada previa y de la siguiente
const MAX_NOGOS_OTRA_BAJADA = 40;  // máximo por cada una de las demás bajadas que quedan por delante
const DIST_LIBRE_M = 30;   // no bloquear lo que queda a menos de esta distancia del inicio/fin del enlace

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
  if (!r.ok) {
    let det = "";
    try { det = (await r.text()).trim().slice(0, 120); } catch (e) {}
    const err = new Error(`BRouter respondió ${r.status}` + (det ? ` (${det})` : ""));
    err.status = r.status;   // 400 = BRouter no encuentra camino entre los dos puntos
    throw err;
  }
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
 * Nogos a lo largo de la bajada que se acaba de hacer (uno cada PASO_NOGO_M metros), recorridos desde su FINAL
 * hacia atrás: si hubiera que recortar por el límite de la URL, se pierde el principio de la bajada, no el final,
 * que es justo donde el enlace empezaría a volver. Se dejan libres los extremos del enlace.
 */
function nogosBajada(f, desde, hasta, max = MAX_NOGOS_POR_BAJADA) {
  const c = f.geometry.coordinates; // [lon, lat, ele]
  if (!c || c.length < 2) return [];
  const nogos = [{ lat: c[c.length - 1][1], lon: c[c.length - 1][0] }];
  let acum = 0;
  for (let i = c.length - 1; i > 0; i--) {
    const a = [c[i][1], c[i][0]], b = [c[i - 1][1], c[i - 1][0]];
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
  return nogos
    .filter(n => haversine([n.lat, n.lon], desde) > DIST_LIBRE_M && haversine([n.lat, n.lon], hasta) > DIST_LIBRE_M)
    .slice(0, max);
}

/**
 * Nogos de un enlace según el nivel de restricción:
 *   nivel 0: bajada previa + siguiente bajada + otras bajadas por delante que quedan cerca del enlace
 *   nivel 1: bajada previa + siguiente bajada
 *   nivel 2: solo la bajada previa
 * "futuras" = bajadas que quedan por hacer, en orden (la primera es la que viene a continuación).
 * Así el enlace no puede subir por una bajada que luego se va a bajar.
 */
function nogosEnlace(previa, futuras, desde, hasta, nivel) {
  const out = [];
  const anadir = (lista) => { for (const n of lista) { if (out.length >= MAX_NOGOS) return; out.push(n); } };
  if (previa) anadir(nogosBajada(previa, desde, hasta));
  if (nivel <= 1 && futuras.length) anadir(nogosBajada(futuras[0], desde, hasta));
  if (nivel === 0 && futuras.length > 1) {
    // Solo las bajadas cercanas al enlace (caja alrededor de origen y destino con margen)
    const margen = Math.max(1000, haversine(desde, hasta));
    const dLat = margen / 111320;
    const dLon = margen / (111320 * Math.max(0.2, Math.cos(desde[0] * Math.PI / 180)));
    const minLat = Math.min(desde[0], hasta[0]) - dLat, maxLat = Math.max(desde[0], hasta[0]) + dLat;
    const minLon = Math.min(desde[1], hasta[1]) - dLon, maxLon = Math.max(desde[1], hasta[1]) + dLon;
    for (const f of futuras.slice(1)) {
      anadir(nogosBajada(f, desde, hasta, MAX_NOGOS_OTRA_BAJADA)
        .filter(n => n.lat >= minLat && n.lat <= maxLat && n.lon >= minLon && n.lon <= maxLon));
    }
  }
  return out;
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
  const nPuntos = seleccion.length - bajadas.length;
  // Se puede generar con bajadas, o solo con puntos si hay al menos dos
  if (bajadas.length === 0 && nPuntos < 2) throw new Error("Hacen falta al menos una bajada o dos puntos");

  const estado = onEstado || (() => {});
  const segmentos = [];
  const waypoints = [];
  const problemas = [];      // uniones imposibles o con salto: si hay alguna, no se genera la ruta

  let ultimaBajada = null;   // bajada recién hecha: el siguiente enlace no puede volver por ella

  async function enlace(desde, hasta, etiqueta, nomDesde, nomHasta, futuras = []) {
    const previa = ultimaBajada; ultimaBajada = null;
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
      // Intentos de más a menos restrictivos; el último siempre es sin nogos (mejor un enlace que ninguno)
      const intentos = [];
      let cuenta = -1;
      for (let nivel = 0; nivel <= 2; nivel++) {
        const l = nogosEnlace(previa, futuras, desde, hasta, nivel);
        if (l.length > 0 && l.length !== cuenta) { intentos.push(l); cuenta = l.length; }
      }
      intentos.push([]);
      for (let i = 0; i < intentos.length; i++) {
        try {
          pts = parsearGPXPuntos(await llamarBRouter(desde[1], desde[0], hasta[1], hasta[0], perfil, intentos[i]));
          // conNogo === false => el enlace no ha podido evitar todas las bajadas (previa o por delante)
          if (intentos[i].length === 0 ? intentos.length > 1 : i > 0) conNogo = false;
          break;
        } catch (e) {
          if (intentos[i].length === 0) throw e;
          console.warn(`Sin ruta con ${intentos[i].length} nogos en ${etiqueta}, reintentando con menos restricciones`, e);
        }
      }
    } catch (e) {
      console.warn(`Error en ${etiqueta}:`, e);
      if (e && e.status === 400) {   // BRouter responde que no hay camino entre los dos puntos
        problemas.push({ motivo: "sin-ruta", d, lat: desde[0], lon: desde[1], lat2: hasta[0], lon2: hasta[1], desde: nomDesde, hasta: nomHasta });
        return;
      }
      throw new Error(`No se pudo calcular el ${etiqueta}: ` + e.message);
    }

    if (pts.length === 0) {
      problemas.push({ motivo: "sin-ruta", d, lat: desde[0], lon: desde[1], lat2: hasta[0], lon2: hasta[1], desde: nomDesde, hasta: nomHasta });
      return;
    }
    // BRouter engancha el origen/destino a su red: si queda lejos, habría una línea recta entre medias
    const ini = pts[0], fin = pts[pts.length - 1];
    const d0 = haversine(desde, [ini[0], ini[1]]);
    const d1 = haversine(hasta, [fin[0], fin[1]]);
    if (d0 > MAX_SALTO_AVISO_M) problemas.push({ motivo: "salto", d: d0, lat: desde[0], lon: desde[1], lat2: ini[0], lon2: ini[1], desde: nomDesde, hasta: nomHasta });
    if (d1 > MAX_SALTO_AVISO_M) problemas.push({ motivo: "salto", d: d1, lat: fin[0], lon: fin[1], lat2: hasta[0], lon2: hasta[1], desde: nomDesde, hasta: nomHasta });
    // conNogo === false => este enlace puede subir por una bajada (no había alternativa)
    segmentos.push({ tipo: "enlace", nombre: etiqueta, puntos: pts, conNogo });
  }

  // Se recorre la lista en orden; "pos" es donde está el ciclista en cada momento
  let pos = null, posNombre = null;
  let nEnlace = 0, nBajada = 0;

  if (puntoInicio) {
    pos = puntoInicio; posNombre = "el inicio";
    waypoints.push({ lat: puntoInicio[0], lon: puntoInicio[1], name: "Inicio ruta" });
  }

  for (let idx = 0; idx < seleccion.length; idx++) {
    const item = seleccion[idx];
    if (item.punto) {
      const destino = [item.lat, item.lon];
      const nomP = `«${item.nombre || "punto intermedio"}»`;
      const futurasP = seleccion.slice(idx + 1).filter(x => !x.punto);
      if (pos) await enlace(pos, destino, pos === puntoInicio ? "enlace inicial" : `enlace ${++nEnlace}`, posNombre, nomP, futurasP);
      waypoints.push({ lat: item.lat, lon: item.lon, name: item.nombre || "Punto intermedio" });
      pos = destino; posNombre = nomP;
      continue;
    }
    nBajada++;
    const nombre = item.properties.nombre || `Bajada ${nBajada}`;
    const ini = puntoInicioBajada(item);
    const futurasB = seleccion.slice(idx).filter(x => !x.punto);   // incluye esta bajada: el enlace no puede subir por ella
    if (pos) await enlace(pos, ini, pos === puntoInicio ? "enlace inicial" : `enlace ${++nEnlace}`, posNombre, `«${nombre}»`, futurasB);
    waypoints.push({ lat: ini[0], lon: ini[1], name: `Inicio ${nombre}` });
    segmentos.push({ tipo: "bajada", nombre, puntos: geometriaBajada(item) });
    ultimaBajada = item;
    estado(`Bajada ${nBajada}/${bajadas.length}: ${nombre}`);
    pos = puntoFinBajada(item); posNombre = `«${nombre}»`;
  }

  if (puntoFin && pos) {
    await enlace(pos, puntoFin, "enlace final", posNombre, "el final");
    waypoints.push({ lat: puntoFin[0], lon: puntoFin[1], name: "Fin ruta" });
  }

  if (problemas.length) {
    const err = new Error(`Ruta incompleta: ${problemas.length} unión${problemas.length === 1 ? "" : "es"} sin camino`);
    err.saltos = problemas;   // el index.html los marca en el mapa
    throw err;
  }
  if (segmentos.length === 0) throw new Error("Los puntos están demasiado cerca para generar una ruta");

  estado("Generando GPX...");
  const puntos = segmentos.flatMap(s => s.puntos);
  return { gpx: construirGPX(puntos, waypoints), segmentos, stats: calcularEstadisticas(segmentos) };
}

window.generarRutaGPX = generarRutaGPX;
window.descargarGPX = descargarGPX;
