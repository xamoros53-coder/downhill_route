// 15-perfil-altimetria.js (líneas 2016-2252 del index.html original)
// ---- Perfil de altimetría ----
const PEND_SUBE = 12;        // % de subida a partir del cual se marca la franja roja
const PEND_BAJA = 15;        // % de bajada a partir del cual se marca la franja azul
const PEND_VENT_M = 30;      // metros a cada lado sobre los que se mide la pendiente (suaviza el ruido de la cota)
const PEND_COLOR_MAX = 25;   // % a partir del cual la franja ya tiene la intensidad máxima
const PEND_MIN_M = 25;       // longitud mínima de un tramo empinado para marcarlo
let perfilPend = [], perfilGrad = [];

function calcularPendientes(pts) {
  const n = pts.length, g = new Array(n).fill(null);
  let i0 = 0, i1 = 0;
  for (let i = 0; i < n; i++) {
    while (i0 < i && pts[i].d - pts[i0].d > PEND_VENT_M) i0++;
    if (i1 < i) i1 = i;
    while (i1 < n - 1 && pts[i1].d - pts[i].d < PEND_VENT_M) i1++;
    const dd = pts[i1].d - pts[i0].d;
    if (dd >= PEND_VENT_M && pts[i1].ele !== null && pts[i0].ele !== null) g[i] = (pts[i1].ele - pts[i0].ele) / dd * 100;
  }
  perfilGrad = g;
  const res = []; let cur = null;
  const cierra = () => { if (cur && cur.d1 - cur.d0 >= PEND_MIN_M) res.push(cur); cur = null; };
  for (let i = 0; i < n; i++) {
    const t = g[i] === null ? null : g[i] >= PEND_SUBE ? "sube" : g[i] <= -PEND_BAJA ? "baja" : null;
    const a = i > 0 ? (pts[i - 1].d + pts[i].d) / 2 : pts[i].d, b = i < n - 1 ? (pts[i].d + pts[i + 1].d) / 2 : pts[i].d;
    if (t && cur && cur.tipo === t) { cur.d1 = b; cur.b = i; cur.max = Math.max(cur.max, Math.abs(g[i])); }
    else { cierra(); if (t) cur = { tipo: t, a: i, b: i, d0: a, d1: b, max: Math.abs(g[i]) }; }
  }
  cierra();
  return res;
}
function construirPerfil(segmentos) {
  const pts = [];
  let d = 0, prev = null, eleAnt = null;
  for (const s of segmentos) for (const p of s.puntos) {
    if (prev) d += haversine([prev[0], prev[1]], [p[0], p[1]]);
    prev = p;
    const ele = (p[2] === null || p[2] === undefined) ? eleAnt : p[2];
    if (ele !== null) eleAnt = ele;
    pts.push({ d, ele, lat: p[0], lon: p[1], color: s.color });
  }
  const primero = pts.find(q => q.ele !== null);
  pts.forEach(q => { if (q.ele === null) q.ele = primero ? primero.ele : null; });
  if (!primero) return { pts: [], total: d };
  const MAX = 800, paso = Math.ceil(pts.length / MAX);
  const red = pts.filter((q, i) => i % paso === 0 || i === pts.length - 1);
  return { pts: red, total: d };
}

// Sitúa cada punto elegido (en orden) sobre el recorrido: distancia acumulada donde la ruta pasa por él
function ubicarPuntosEnPerfil(pts, puntos) {
  const dist = (q, p) => Math.hypot((q.lat - p.lat) * 111320, (q.lon - p.lon) * 111320 * Math.cos(p.lat * Math.PI / 180));
  const res = []; let desde = 0;
  puntos.forEach((p, k) => {
    let mejor = -1, mejorD = Infinity;
    for (let i = desde; i < pts.length; i++) { const d = dist(pts[i], p); if (d < mejorD) { mejorD = d; mejor = i; } }
    for (let i = desde; i < pts.length; i++) {          // primer paso por el punto (no uno posterior más cercano por casualidad)
      if (dist(pts[i], p) < 40) {
        let j = i; while (j + 1 < pts.length && dist(pts[j + 1], p) < dist(pts[j], p)) j++;
        mejor = j; break;
      }
    }
    if (mejor < 0) return;
    desde = mejor;
    res.push({ d: pts[mejor].d, n: k + 1, nombre: p.nombre });
  });
  return res;
}

function mostrarPerfil(segmentos, st, puntosSel = []) {
  const { pts, total } = construirPerfil(segmentos);
  perfilDatos = pts.length > 1 ? pts : null;
  perfilPuntos = perfilDatos ? ubicarPuntosEnPerfil(pts, puntosSel) : [];
  perfilPend = perfilDatos ? calcularPendientes(pts) : [];
  perfilZoom = 1; perfilCentro = null;
  let t = `<strong>${fmtLong(Math.round(total))}</strong>`;
  if (st.sube !== null) t += ` · ↑${st.sube} m ↓${st.baja} m`;
  document.getElementById("perfilResumen").innerHTML = t;
  document.getElementById("perfilInfo").textContent = "";
  document.getElementById("mapwrap").classList.add("conPerfil");
  if (perfilDatos) document.getElementById("mapwrap").classList.add("hayPerfil");
  dibujarPerfil();
}

function ocultarPerfil() {
  perfilDatos = null; perfilGeom = null; perfilPuntos = []; perfilPend = []; perfilGrad = [];
  perfilZoom = 1; perfilCentro = null;
  actualizarBotonesPerfil();
  document.getElementById("mapwrap").classList.remove("conPerfil", "hayPerfil");
  document.getElementById("perfilGraf").innerHTML = "";
  if (markerPerfil) markerPerfil.getElement().style.display = "none";
}

// Ventana visible del perfil según el zoom (si estás siguiendo la ruta, se centra en ti)
function perfilVentana() {
  const total = perfilDatos[perfilDatos.length - 1].d || 1;
  const maxZ = Math.max(1, total / PERFIL_VENTANA_MIN_M);
  perfilZoom = Math.min(Math.max(1, perfilZoom), maxZ);
  const span = total / perfilZoom;
  let c = perfilCentro;
  if (typeof siguiendo !== "undefined" && siguiendo && seguirUlt) c = seguirUlt.d;
  if (c === null || c === undefined) c = total / 2;
  const d0 = Math.max(0, Math.min(total - span, c - span / 2));
  perfilCentro = d0 + span / 2;
  return { d0, span, total, maxZ };
}
function perfilZoomar(f, dFijo) {
  if (!perfilDatos) return;
  const v = perfilVentana();
  const nz = Math.min(v.maxZ, Math.max(1, perfilZoom * f));
  if (nz === perfilZoom) return;
  const nspan = v.total / nz;
  if (dFijo !== undefined) perfilCentro = dFijo - (dFijo - v.d0) / v.span * nspan + nspan / 2;   // rueda: el punto bajo el cursor no se mueve
  perfilZoom = nz;
  dibujarPerfil();
}
function perfilDesplazar(dir) {
  if (!perfilDatos) return;
  const v = perfilVentana();
  perfilCentro = v.d0 + v.span / 2 + dir * v.span * 0.5;
  dibujarPerfil();
}
function actualizarBotonesPerfil() {
  const g = (id) => document.getElementById(id);
  const hay = !!perfilDatos, total = hay ? (perfilDatos[perfilDatos.length - 1].d || 1) : 1;
  const sig = typeof siguiendo !== "undefined" && siguiendo;
  g("pfZoomMenos").disabled = !hay || perfilZoom <= 1;
  g("pfZoomMas").disabled = !hay || perfilZoom >= Math.max(1, total / PERFIL_VENTANA_MIN_M) - 1e-9;
  g("pfIzq").hidden = g("pfDer").hidden = !(hay && perfilZoom > 1 && !sig);
}

function dibujarPerfil() {
  const cont = document.getElementById("perfilGraf");
  if (!perfilDatos) { cont.innerHTML = '<div class="vacio">Sin datos de altitud para dibujar el perfil.</div>'; actualizarBotonesPerfil(); return; }
  const pts = perfilDatos, W = cont.clientWidth, H = cont.clientHeight;
  if (!W || !H) return;
  const ML = 44, MR = 12, MT = 8, MB = 18;
  const { d0, span, total } = perfilVentana();
  const d1 = d0 + span;
  perfilCentroDib = d0 + span / 2;
  // solo se dibujan los puntos de la ventana (más un vecino a cada lado para que la línea llegue al borde)
  let a = 0; while (a < pts.length - 1 && pts[a + 1].d <= d0) a++;
  let b = pts.length - 1; while (b > a && pts[b - 1].d >= d1) b--;
  const vis = pts.slice(a, b + 1);
  let lo = Infinity, hi = -Infinity;
  vis.forEach(q => { if (q.d >= d0 && q.d <= d1) { if (q.ele < lo) lo = q.ele; if (q.ele > hi) hi = q.ele; } });
  if (!isFinite(lo)) vis.forEach(q => { if (q.ele < lo) lo = q.ele; if (q.ele > hi) hi = q.ele; });
  let emin = lo, emax = hi;
  if (emax - emin < 20) { const c = (emax + emin) / 2; emin = c - 10; emax = c + 10; }
  const pad = (emax - emin) * 0.08; emin -= pad; emax += pad;
  const X = d => ML + (d - d0) / span * (W - ML - MR);
  const Y = e => MT + (1 - (e - emin) / (emax - emin)) * (H - MT - MB);
  perfilGeom = { ML, MR, W, total, d0, span };

  let s = `<svg width="${W}" height="${H}" style="display:block"><defs><clipPath id="pfClip"><rect x="${ML}" y="0" width="${W - ML - MR}" height="${H - MB}"/></clipPath></defs>`;
  for (const e of [lo, (lo + hi) / 2, hi]) {
    s += `<line x1="${ML}" x2="${W - MR}" y1="${Y(e).toFixed(1)}" y2="${Y(e).toFixed(1)}" stroke="#e3e3e3"/>`
       + `<text x="${ML - 5}" y="${(Y(e) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#777">${Math.round(e)} m</text>`;
  }
  const km = span / 1000; let paso = 0.1;
  for (const c of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]) { paso = c; if (km / c <= 8) break; }
  let primera = true;
  for (let k = Math.ceil(d0 / (paso * 1000) - 1e-9); k * paso * 1000 <= d1 + 1e-6; k++) {
    const x = X(k * paso * 1000).toFixed(1);
    const etiqueta = String(+(k * paso).toFixed(2)).replace(".", ",") + (primera ? " km" : "");
    primera = false;
    s += `<line x1="${x}" x2="${x}" y1="${MT}" y2="${H - MB}" stroke="#f0f0f0"/>`
       + `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#777">${etiqueta}</text>`;
  }
  s += `<g clip-path="url(#pfClip)">`;
  const area = vis.map(q => `${X(q.d).toFixed(1)},${Y(q.ele).toFixed(1)}`);
  s += `<polygon points="${X(vis[0].d).toFixed(1)},${H - MB} ${area.join(" ")} ${X(vis[vis.length - 1].d).toFixed(1)},${H - MB}" fill="rgba(44,62,80,.10)"/>`;
  // zonas de pendiente fuerte bajo la línea del perfil: rojo = subida muy empinada, azul = bajada con mucha pendiente.
  // Cuanto más inclinada, más intensa
  for (const t of perfilPend) {
    if (t.d1 < d0 || t.d0 > d1) continue;
    const sube = t.tipo === "sube", umbral = sube ? PEND_SUBE : PEND_BAJA, rgb = sube ? "214,47,47" : "26,115,232";
    for (let k = t.a; k <= Math.min(t.b, pts.length - 2); k++) {
      const p = pts[k], q = pts[k + 1];
      if (q.d < d0 || p.d > d1) continue;
      const gr = Math.abs(((perfilGrad[k] ?? 0) + (perfilGrad[k + 1] ?? 0)) / 2);
      const inten = Math.min(1, Math.max(0, (gr - umbral) / (PEND_COLOR_MAX - umbral)));
      const al = (0.18 + 0.62 * inten).toFixed(2);
      const x1 = X(p.d).toFixed(1), x2 = X(q.d).toFixed(1), yb = H - MB;
      s += `<polygon points="${x1},${yb} ${x1},${Y(p.ele).toFixed(1)} ${x2},${Y(q.ele).toFixed(1)} ${x2},${yb}" fill="rgba(${rgb},${al})" shape-rendering="crispEdges">`
         + `<title>${sube ? "Subida muy empinada" : "Bajada con mucha pendiente"} · ${Math.round(gr)} %</title></polygon>`;
    }
  }
  // línea por tramos de color (bajadas con su dificultad, enlaces en morado)
  let run = [], col = null;
  const cierra = () => { if (run.length > 1) s += `<polyline points="${run.join(" ")}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`; };
  vis.forEach((q, i) => {
    const c = q.color || COLOR_RUTA, p = `${X(q.d).toFixed(1)},${Y(q.ele).toFixed(1)}`;
    if (c !== col) { cierra(); run = i > 0 ? [`${X(vis[i - 1].d).toFixed(1)},${Y(vis[i - 1].ele).toFixed(1)}`] : []; col = c; }
    run.push(p);
  });
  cierra();
  s += `</g>`;
  // puntos elegidos por el usuario (mismo número y color que en el mapa)
  for (const pp of perfilPuntos) {
    if (pp.d < d0 || pp.d > d1) continue;
    const x = X(pp.d).toFixed(1);
    s += `<g><title>${esc(pp.nombre || "Punto " + pp.n)}</title>`
       + `<line x1="${x}" x2="${x}" y1="${MT}" y2="${H - MB}" stroke="${COLOR_RUTA}" stroke-width="1.5" stroke-dasharray="4 3"/>`
       + `<circle cx="${x}" cy="${MT + 9}" r="9" fill="${COLOR_RUTA}" stroke="#fff" stroke-width="2"/>`
       + `<text x="${x}" y="${MT + 13}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${pp.n}</text></g>`;
  }
  s += `<line id="pfLinea" y1="${MT}" y2="${H - MB}" stroke="#555" stroke-dasharray="3 3" style="display:none"/>`
     + `<circle id="pfPunto" r="4.5" fill="#fff" stroke="#1a1a1a" stroke-width="2" style="display:none"/></svg>`;
  cont.innerHTML = s;
  perfilGeom.X = X; perfilGeom.Y = Y;
  actualizarYoPerfil();
  actualizarBotonesPerfil();
}

function hoverPerfil(ev) {
  if (!perfilDatos || !perfilGeom) return;
  const cont = document.getElementById("perfilGraf"), g = perfilGeom, pts = perfilDatos;
  const r = cont.getBoundingClientRect();
  let d = g.d0 + (ev.clientX - r.left - g.ML) / (g.W - g.ML - g.MR) * g.span;
  d = Math.max(0, Math.min(g.total, d));
  let a = 0, b = pts.length - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (pts[m].d < d) a = m; else b = m; }
  const i = (d - pts[a].d < pts[b].d - d) ? a : b, q = pts[i];
  let i0 = i, i1 = i;
  while (i0 > 0 && q.d - pts[i0].d < 30) i0--;
  while (i1 < pts.length - 1 && pts[i1].d - q.d < 30) i1++;
  const dd = pts[i1].d - pts[i0].d;
  const pend = dd > 5 ? (pts[i1].ele - pts[i0].ele) / dd * 100 : null;
  const linea = document.getElementById("pfLinea"), punto = document.getElementById("pfPunto");
  if (linea && punto) {
    const x = g.X(q.d).toFixed(1);
    linea.setAttribute("x1", x); linea.setAttribute("x2", x); linea.style.display = "";
    punto.setAttribute("cx", x); punto.setAttribute("cy", g.Y(q.ele).toFixed(1)); punto.style.display = "";
  }
  document.getElementById("perfilInfo").textContent =
    `km ${(q.d / 1000).toFixed(2).replace(".", ",")} · ${Math.round(q.ele)} m` + (pend !== null ? ` · ${pend > 0 ? "+" : pend < 0 ? "−" : ""}${Math.abs(pend).toFixed(0)} %` : "");
  if (!markerPerfil) {
    const el = document.createElement("div");
    el.style.cssText = "width:18px;height:18px;border-radius:50%;background:#ffd400;border:3px solid #1a1a1a;box-shadow:0 0 0 2px #fff;pointer-events:none;z-index:5";
    markerPerfil = new maplibregl.Marker({ element: el }).setLngLat([q.lon, q.lat]).addTo(map);
  }
  markerPerfil.setLngLat([q.lon, q.lat]);
  markerPerfil.getElement().style.display = "";
  // que la bola se vea siempre: dentro del mapa y por encima del perfil de altimetría
  const cm = map.getContainer(), px = map.project([q.lon, q.lat]), panel = document.getElementById("perfilAlt");
  const mx = 40, arriba = 80, abajo = cm.clientHeight - (panel ? panel.offsetHeight : 0) - 40;
  let dx = 0, dy = 0;
  if (px.x < mx) dx = px.x - mx; else if (px.x > cm.clientWidth - mx) dx = px.x - (cm.clientWidth - mx);
  if (px.y < arriba) dy = px.y - arriba; else if (px.y > abajo) dy = px.y - abajo;
  if (dx || dy) map.panBy([dx, dy], { duration: 0 });
}
function salirPerfil() {
  const linea = document.getElementById("pfLinea"), punto = document.getElementById("pfPunto");
  if (linea) linea.style.display = "none";
  if (punto) punto.style.display = "none";
  document.getElementById("perfilInfo").textContent = (typeof siguiendo !== "undefined" && siguiendo) ? textoSeguir : "";
  if (markerPerfil) markerPerfil.getElement().style.display = "none";
}
const perfilGrafEl = document.getElementById("perfilGraf");
perfilGrafEl.addEventListener("pointerdown", (ev) => {
  perfilScrub = true;
  try { perfilGrafEl.setPointerCapture(ev.pointerId); } catch (e) {}   // sigue el dedo aunque se salga del gráfico
  hoverPerfil(ev);
});
perfilGrafEl.addEventListener("pointerup", () => { perfilScrub = false; });
perfilGrafEl.addEventListener("pointercancel", () => { perfilScrub = false; });
perfilGrafEl.addEventListener("wheel", (ev) => {   // ratón: la rueda acerca/aleja alrededor del cursor
  if (!perfilDatos || !perfilGeom) return;
  ev.preventDefault();
  const g = perfilGeom, r = perfilGrafEl.getBoundingClientRect();
  const d = g.d0 + Math.min(1, Math.max(0, (ev.clientX - r.left - g.ML) / (g.W - g.ML - g.MR))) * g.span;
  perfilZoomar(ev.deltaY < 0 ? 1.4 : 1 / 1.4, d);
}, { passive: false });
document.getElementById("pfZoomMas").addEventListener("click", () => perfilZoomar(2));
document.getElementById("pfZoomMenos").addEventListener("click", () => perfilZoomar(0.5));
document.getElementById("pfIzq").addEventListener("click", () => perfilDesplazar(-1));
document.getElementById("pfDer").addEventListener("click", () => perfilDesplazar(1));
perfilGrafEl.addEventListener("pointermove", hoverPerfil);
perfilGrafEl.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") salirPerfil(); });   // en táctil la bola se queda al soltar
document.getElementById("perfilCerrar").addEventListener("click", () => {
  document.getElementById("mapwrap").classList.remove("conPerfil"); salirPerfil();
  setTimeout(() => map.resize(), 0);
});
// Botón para volver a abrir el perfil después de cerrarlo
document.getElementById("btnPerfilVer").addEventListener("click", () => {
  if (!perfilDatos) return;
  document.getElementById("mapwrap").classList.add("conPerfil");
  dibujarPerfil();
  setTimeout(() => map.resize(), 0);
});
window.addEventListener("resize", () => { if (perfilDatos && document.getElementById("mapwrap").classList.contains("conPerfil")) dibujarPerfil(); });

