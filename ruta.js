// ruta.js — generación de GPX con enlaces BRouter (única restricción: no volver por la bajada recién hecha)
// Expone window.generarRutaGPX y window.descargarGPX para el index.html
//
// Uso:
//   generarRutaGPX(seleccion, puntoInicio, puntoFin, perfil, onEstado, todasLasBajadas)
//   - seleccion:       features (GeoJSON) de las bajadas elegidas, en orden
//   - puntoInicio/Fin: [lat, lon] o null
//   - todasLasBajadas: ya no se usa (se mantiene en la firma por compatibilidad con index.html)
//   - opciones:        { optimizar: true, cancelado: () => bool }
//       optimizar: reordena bajadas y puntos intermedios para minimizar la subida total de los enlaces
//                  (el primer elemento de la lista —o puntoInicio, si se da— se mantiene como salida)

const BROUTER_URL = "https://brouter.de/brouter";
const MAX_SALTO_AVISO_M = 80;
const AVISO_ENLACE_LARGO_KM = 20;
const MIN_ENLACE_M = 30; // enlaces más cortos se saltan (BRouter no aporta nada)

// --- Única restricción: no volver por la bajada que se acaba de hacer ---
const RADIO_NOGO_M = 20;   // radio de cada círculo bloqueado
const PASO_NOGO_M = 30;    // un nogo cada 30 m (menor que 2*radio => círculos solapados)
const MAX_NOGOS = 150;     // límite para que la URL no sea enorme
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
function nogosUltimaBajada(f, desde, hasta) {
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

// --- Optimización del orden: menos subida total en los enlaces ---
const PESO_DIST = 0.01;       // 1 km de enlace "cuesta" lo mismo que 10 m de subida (solo desempata)
const COMPLETA_HASTA = 8;     // hasta este nº de elementos se calculan todos los enlaces posibles con BRouter
const K_CERCANOS = 4;         // con más elementos, solo los K destinos más cercanos de cada uno
const MAX_DP = 13;            // hasta este nº de elementos se busca el orden óptimo exacto
const CONCURRENCIA = 4;       // peticiones simultáneas a BRouter
const MEJORA_MINIMA = 10;     // si el nuevo orden no mejora al menos esto, se respeta el orden del usuario
const INF = 1e9;

const claveEnlace = (a, b) => `${a[0].toFixed(6)},${a[1].toFixed(6)}>${b[0].toFixed(6)},${b[1].toFixed(6)}`;

function subidaPts(pts) {
  let sube = 0, ant = null, conEle = 0;
  for (const p of pts) {
    if (p[2] === null || p[2] === undefined) continue;
    conEle++;
    if (ant !== null && p[2] > ant) sube += p[2] - ant;
    ant = p[2];
  }
  return conEle / Math.max(1, pts.length) > 0.9 ? sube : longitudM(pts) * 0.04;   // sin cotas: se estima
}

function tocaNogos(pts, nogos) {
  if (!nogos.length) return false;
  for (const p of pts) for (const n of nogos) if (haversine([p[0], p[1]], [n.lat, n.lon]) < RADIO_NOGO_M) return true;
  return false;
}

async function enParalelo(tareas, limite, alProgreso) {
  let k = 0, hechas = 0;
  const trabajadores = Array.from({ length: Math.min(limite, tareas.length) }, async () => {
    while (true) {
      const i = k++;
      if (i >= tareas.length) return;
      await tareas[i]();
      alProgreso(++hechas, tareas.length);
    }
  });
  await Promise.all(trabajadores);
}

/**
 * Busca el orden de las bajadas y puntos con menos subida total. Las bajadas no se pueden recorrer al revés.
 * El primer elemento (o puntoInicio) queda fijo. Si hay puntoFin (ruta circular) también cuenta la vuelta.
 * Devuelve { orden } (índices de "seleccion" en el nuevo orden). Rellena "cache" con los enlaces calculados.
 */
async function optimizarOrden(seleccion, puntoInicio, puntoFin, perfil, estado, cancelado, cache) {
  const nodos = [];
  if (puntoInicio) nodos.push({ idx: -1, ent: puntoInicio, sal: puntoInicio });
  seleccion.forEach((it, k) => nodos.push(it.punto
    ? { idx: k, ent: [it.lat, it.lon], sal: [it.lat, it.lon] }
    : { idx: k, ent: puntoInicioBajada(it), sal: puntoFinBajada(it) }));
  const m = nodos.length, hayFin = !!puntoFin;
  const original = seleccion.map((_, k) => k);
  if (m < 3) return { orden: original, cambio: false };

  const destino = j => j === m ? puntoFin : nodos[j].ent;
  const dist = (i, j) => haversine(nodos[i].sal, destino(j));
  const clave = (i, j) => i * (m + 1) + j;

  // 1) Qué enlaces se calculan con BRouter
  const pares = new Set();
  const add = (i, j) => { if (i !== j && j >= 1) pares.add(clave(i, j)); };
  for (let i = 0; i < m - 1; i++) add(i, i + 1);   // siempre el orden actual (para poder compararlo)
  if (hayFin) add(m - 1, m);
  if (m <= COMPLETA_HASTA) {
    for (let i = 0; i < m; i++) for (let j = 1; j < m; j++) add(i, j);
    if (hayFin) for (let i = 1; i < m; i++) add(i, m);
  } else {
    for (let i = 0; i < m; i++) {
      const js = []; for (let j = 1; j < m; j++) if (j !== i) js.push(j);
      js.sort((a, b) => dist(i, a) - dist(i, b));
      js.slice(0, K_CERCANOS).forEach(j => add(i, j));
    }
    if (hayFin) {
      const is = []; for (let i = 1; i < m; i++) is.push(i);
      is.sort((a, b) => dist(a, m) - dist(b, m));
      is.slice(0, K_CERCANOS * 2).forEach(i => add(i, m));
    }
  }

  // 2) Se calculan (en paralelo) y se guarda subida y distancia de cada uno
  const M = new Map();
  const tareas = [];
  let fallos = 0;
  for (const key of pares) {
    const i = Math.floor(key / (m + 1)), j = key % (m + 1);
    const desde = nodos[i].sal, hasta = destino(j), d = haversine(desde, hasta);
    if (d < MIN_ENLACE_M || d > AVISO_ENLACE_LARGO_KM * 1000) continue;
    tareas.push(async () => {
      if (cancelado && cancelado()) return;
      for (let intento = 0; intento < 2; intento++) {
        try {
          const pts = parsearGPXPuntos(await llamarBRouter(desde[1], desde[0], hasta[1], hasta[0], perfil, []));
          if (!pts.length) { M.set(key, { sube: INF, dist: 0 }); return; }
          M.set(key, { sube: subidaPts(pts), dist: longitudM(pts) });
          cache.set(claveEnlace(desde, hasta), pts);
          return;
        } catch (e) {
          if (e && e.status === 400) { M.set(key, { sube: INF, dist: 0 }); return; }   // no hay camino
          if (intento === 1) fallos++; else await new Promise(r => setTimeout(r, 700));
        }
      }
    });
  }
  await enParalelo(tareas, CONCURRENCIA, (h, t) => estado(`Buscando el orden con menos subida… (${h}/${t})`));
  if (cancelado && cancelado()) { const e = new Error("Optimización cancelada"); e.cancelada = true; throw e; }
  if (tareas.length && fallos > tareas.length * 0.3) return { orden: original, cambio: false, fallo: true };

  // 3) Matriz de costes (los enlaces no calculados se estiman a partir de la distancia en línea recta)
  const estSube = d => d * 1.3 * 0.04;
  const C = [], S = [];
  for (let i = 0; i < m; i++) {
    C.push(new Array(m + 1).fill(INF)); S.push(new Array(m + 1).fill(INF));
    for (let j = 1; j <= m; j++) {
      if (i === j || (j === m && !hayFin)) continue;
      const p = M.get(clave(i, j));
      if (p) { S[i][j] = p.sube; C[i][j] = p.sube >= INF ? INF : p.sube + p.dist * PESO_DIST; continue; }
      const d = dist(i, j);
      if (d < MIN_ENLACE_M) { S[i][j] = 0; C[i][j] = 0; }
      else { S[i][j] = estSube(d); C[i][j] = estSube(d) + d * 1.3 * PESO_DIST + 30; }
    }
  }
  const suma = (M2, ord) => {
    let t = 0;
    for (let k = 0; k < ord.length - 1; k++) t += M2[ord[k]][ord[k + 1]];
    if (hayFin) t += M2[ord[ord.length - 1]][m];
    return t;
  };
  const coste = ord => suma(C, ord);

  // 4) Búsqueda del mejor orden (el nodo 0 es la salida y va siempre primero)
  const ord0 = Array.from({ length: m }, (_, i) => i);
  let mejor;
  if (m <= MAX_DP) {           // exacto: programación dinámica sobre subconjuntos
    const n = m - 1, FULL = (1 << n) - 1;
    const dp = new Float64Array((FULL + 1) * n).fill(Infinity), padre = new Int8Array((FULL + 1) * n).fill(-1);
    for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = C[0][j + 1];
    for (let mask = 1; mask <= FULL; mask++) for (let l = 0; l < n; l++) {
      if (!(mask & (1 << l))) continue;
      const cur = dp[mask * n + l]; if (cur === Infinity) continue;
      for (let x = 0; x < n; x++) {
        if (mask & (1 << x)) continue;
        const nm = mask | (1 << x), v = cur + C[l + 1][x + 1];
        if (v < dp[nm * n + x]) { dp[nm * n + x] = v; padre[nm * n + x] = l; }
      }
    }
    let fin = -1, vf = Infinity;
    for (let l = 0; l < n; l++) { const v = dp[FULL * n + l] + (hayFin ? C[l + 1][m] : 0); if (v < vf) { vf = v; fin = l; } }
    const rev = []; let mask = FULL, l = fin;
    while (l >= 0) { rev.push(l + 1); const pl = padre[mask * n + l]; mask &= ~(1 << l); l = pl; }
    mejor = [0, ...rev.reverse()];
  } else {                     // muchos elementos: vecino más cercano + reubicaciones sucesivas
    const mejorar = (ord) => {
      let cambio = true, pasos = 0;
      while (cambio && pasos++ < 100) {
        cambio = false;
        for (let a = 1; a < ord.length; a++) {
          const x = ord[a], resto = ord.filter((_, k) => k !== a);
          let mc = coste(ord), mo = null;
          for (let b = 1; b <= resto.length; b++) {
            if (b === a) continue;
            const cand = [...resto.slice(0, b), x, ...resto.slice(b)], c = coste(cand);
            if (c < mc - 1e-6) { mc = c; mo = cand; }
          }
          if (mo) { ord = mo; cambio = true; }
        }
      }
      return ord;
    };
    const nn = [0], libres = new Set(ord0.slice(1));
    while (libres.size) {
      let bj = -1, bc = Infinity;
      for (const j of libres) if (C[nn[nn.length - 1]][j] < bc) { bc = C[nn[nn.length - 1]][j]; bj = j; }
      nn.push(bj); libres.delete(bj);
    }
    const a = mejorar(ord0.slice()), b = mejorar(nn);
    mejor = coste(a) <= coste(b) ? a : b;
  }

  const cAntes = coste(ord0), cDespues = coste(mejor);
  const cambia = cDespues < cAntes - MEJORA_MINIMA;
  const elegido = cambia ? mejor : ord0;
  const antes = suma(S, ord0), despues = suma(S, elegido);
  return {
    orden: elegido.map(n => nodos[n].idx).filter(k => k >= 0),
    cambio: cambia && elegido.some((n, i) => n !== i),
    antes: antes >= INF ? null : Math.round(antes),
    despues: despues >= INF ? null : Math.round(despues)
  };
}

async function generarRutaGPX(seleccion, puntoInicio, puntoFin, perfil, onEstado, todasLasBajadas, opciones) {
  // "seleccion" es la lista ordenada de la ruta: bajadas (features GeoJSON)
  // y puntos intermedios ({ punto: true, lat, lon, nombre }).
  const bajadas = seleccion.filter(x => !x.punto);
  const nPuntos = seleccion.length - bajadas.length;
  // Se puede generar con bajadas, o solo con puntos si hay al menos dos
  if (bajadas.length === 0 && nPuntos < 2) throw new Error("Hacen falta al menos una bajada o dos puntos");

  const estado = onEstado || (() => {});

  // Orden de la ruta: opcionalmente se reordena para minimizar la subida (el primer elemento se queda como salida)
  const cache = new Map();   // enlaces ya calculados al optimizar: se reutilizan si no pasan por la bajada recién hecha
  let orden = seleccion.map((_, k) => k), optimizacion = null;
  if (opciones && opciones.optimizar) {
    try {
      const o = await optimizarOrden(seleccion, puntoInicio, puntoFin, perfil, estado, opciones.cancelado, cache);
      orden = o.orden; optimizacion = o;
    } catch (e) {
      if (e && e.cancelada) throw e;
      console.warn("No se pudo optimizar el orden, se usa el orden de la lista", e);
      optimizacion = { cambio: false, fallo: true };
    }
  }
  const original = seleccion;
  seleccion = orden.map(k => original[k]);
  let nPun = 0;   // los puntos sin nombre se numeran según su posición final
  seleccion = seleccion.map(it => it.punto ? (nPun++, { ...it, nombre: it.nombre || `Punto ${nPun}` }) : it);

  const segmentos = [];
  const waypoints = [];
  const problemas = [];      // uniones imposibles o con salto: si hay alguna, no se genera la ruta

  let ultimaBajada = null;   // bajada recién hecha: el siguiente enlace no puede volver por ella

  async function enlace(desde, hasta, etiqueta, nomDesde, nomHasta) {
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
      const nogos = previa ? nogosUltimaBajada(previa, desde, hasta) : [];
      const guardado = cache.get(claveEnlace(desde, hasta));
      if (guardado && guardado.length && !tocaNogos(guardado, nogos)) pts = guardado;   // ya calculado y sin pasar por la bajada anterior
      else try {
        pts = parsearGPXPuntos(await llamarBRouter(desde[1], desde[0], hasta[1], hasta[0], perfil, nogos));
      } catch (e) {
        // Sin ruta posible sin volver por la última bajada: reintenta sin restricciones
        if (nogos.length === 0) throw e;
        console.warn(`Sin ruta con nogos en ${etiqueta}, reintentando sin ellos`, e);
        pts = parsearGPXPuntos(await llamarBRouter(desde[1], desde[0], hasta[1], hasta[0], perfil, []));
        conNogo = false;
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

  for (const item of seleccion) {
    if (item.punto) {
      const destino = [item.lat, item.lon];
      const nomP = `«${item.nombre || "punto intermedio"}»`;
      if (pos) await enlace(pos, destino, pos === puntoInicio ? "enlace inicial" : `enlace ${++nEnlace}`, posNombre, nomP);
      waypoints.push({ lat: item.lat, lon: item.lon, name: item.nombre || "Punto intermedio" });
      pos = destino; posNombre = nomP;
      continue;
    }
    nBajada++;
    const nombre = item.properties.nombre || `Bajada ${nBajada}`;
    const ini = puntoInicioBajada(item);
    if (pos) await enlace(pos, ini, pos === puntoInicio ? "enlace inicial" : `enlace ${++nEnlace}`, posNombre, `«${nombre}»`);
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
  return { gpx: construirGPX(puntos, waypoints), segmentos, stats: calcularEstadisticas(segmentos), seleccion, orden, optimizacion };
}

window.generarRutaGPX = generarRutaGPX;
window.descargarGPX = descargarGPX;
