// 04-estado.js (líneas 791-819 del index.html original)
let features = [];                 // bajadas cargadas (se rehace en actualizarMapa)
const porId = new Map();           // id -> feature de la bajada
const tramosPorId = new Map();     // id -> trozos coloreados para dibujarla
let descartadas = new Set();       // ids que el perfil completo ha desmentido
let seleccionada = null;
let cargandoZona = false;
const perfilesEnCurso = new Map(); // id -> Promise (no se pide dos veces el mismo perfil)

const STORAGE_KEY = "miRuta_v2";
const STORAGE_BAJADAS = "miRuta_bajadas_v2";
const STORAGE_DESCARTADAS = "descartadas_v2";
const STORAGE_INICIO = "miRuta_inicio_v1";
const STORAGE_FIN = "miRuta_fin_v1";
let miRuta = [];                    // ids en orden: bajadas y puntos intermedios ("wp:...")
const puntosInter = new Map();      // id "wp:..." -> [lat, lon]
let markersInter = [];
const STORAGE_INTER = "miRuta_inter_v1";
function esPunto(id) { return typeof id === "string" && id.startsWith("wp:"); }
let puntoInicio = null;
let puntoFin = null;
let modoMarcar = null;
let rutaGenerada = null;   // { gpx, segmentos, stats } de la última ruta calculada
let perfilDatos = null, perfilGeom = null, markerPerfil = null;
let perfilPuntos = [];   // puntos elegidos sobre el perfil: { d, n, nombre }
let perfilZoom = 1, perfilCentro = null, perfilCentroDib = null, perfilScrub = false;   // zoom horizontal del perfil
const PERFIL_VENTANA_MIN_M = 150;   // lo máximo que se puede acercar: tramos de 150 m
let versionRuta = 0;       // sube con cada cambio; descarta cálculos que ya no valen
const COLOR_RUTA = "#7b1fa2"; // enlaces y contorno de las bajadas de la ruta

