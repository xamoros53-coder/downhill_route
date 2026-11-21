# Generador de bajadas (piloto Maresme)

Prepara de antemano las bajadas de una zona, para que la app no tenga que buscarlas en internet cada vez.

## Qué hace

1. **descargar**: baja de OpenStreetMap los senderos con etiquetas MTB de la zona (una vez).
2. **generar**: agrupa los tramos en bajadas, comprueba el sentido con la elevación del IGN (MDT05) y calcula el perfil de cada una. Es la misma lógica que tiene hoy la app, traducida a Python.

Resultado, en `salida/maresme/`:

| Archivo | Para qué sirve |
|---|---|
| `celdas/*.json` | Las bajadas, en cuadrículas de 0,1° (~11 km). Es lo que leerá la app. |
| `indice.json` | Qué cuadrículas hay, cuántas bajadas, fecha de los datos de OSM y estadísticas. |
| `revision/bajadas.geojson` | Para **ver el resultado en un mapa**: arrástralo a https://geojson.io |
| `revision/resumen.csv` | Lista de bajadas (abre con Excel): nombre, longitud, caída, dificultad... |
| `revision/retiradas.csv` | Bajadas que se han quitado al calcular el perfil, con el motivo. |

## Preparación (una sola vez)

Abre una terminal dentro de la carpeta `generador`.

**Windows (PowerShell):**
```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```
**Mac / Linux:**
```
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
Cada vez que abras una terminal nueva, repite solo la línea `activate`.

## Ejecución

Pon tu correo en `--contacto`: se envía en la cabecera de las peticiones a OpenStreetMap y al IGN para que puedan avisarte si hay algún problema.

```
python generar.py descargar --zona maresme --contacto tucorreo@ejemplo.com
python generar.py generar   --zona maresme --contacto tucorreo@ejemplo.com
```

- `descargar` tarda unos minutos (hace una pausa entre cuadrículas por cortesía con el servidor).
- `generar` es la parte larga: descarga teselas de elevación del IGN. Se guardan en `cache/mdt/`. **Si se corta internet o cierras la ventana, vuelve a ejecutar el mismo comando: continúa donde se quedó.**
- La segunda vez que lo ejecutes (por ejemplo, tras mejorar una regla) ya no descarga nada y es mucho más rápido.

Otra zona: `--bbox SUR OESTE NORTE ESTE` (en grados), por ejemplo `--bbox 41.3 2.0 41.5 2.3`.

## Cómo revisar el resultado

1. Mira lo que imprime `generar` al terminar: tramos con etiquetas MTB, candidatas, descartadas por sentido dudoso, retiradas, bajadas finales.
2. Arrastra `revision/bajadas.geojson` a geojson.io. Cada bajada sale con el color de su dificultad y, al pulsarla, su nombre, longitud y caída.
3. Compáralo con la app: carga una zona del Maresme en la app actual y comprueba que salen las mismas bajadas (y, sobre todo, que las que tú conoces están).
4. Apunta lo que falte, lo que sobre o lo que esté mal orientado.

## Carpeta `pruebas/`

No hace falta para usar el generador. Contiene la comprobación de que esta versión en Python da exactamente los mismos resultados que el `osm.js` y `elevacion.js` de la app (necesita Node.js, y la hice con datos sintéticos).

## Atribución de los datos

© colaboradores de OpenStreetMap (ODbL) · Elevación: MDT05 © Instituto Geográfico Nacional de España (CC BY 4.0).


python diagnostico.py --zona maresme --nombre Uiuiuis --contacto xamoros53@gmail.com --servidor https://overpass-api.de/api/interpreter

python diagnostico.py --zona maresme --way 332100630 --contacto xamoros53@gmail.com --servidor https://overpass-api.de/api/interpreter

python generar.py descargar --zona maresme --sin-etiqueta --contacto xamoros53@gmail.com
python generar.py generar   --zona maresme --contacto xamoros53@gmail.com

python generar.py descargar --zona maresme --sin-etiqueta --contacto xamoros53@gmail.com --servidor https://overpass-api.de/api/interpreter

https://download.geofabrik.de/europe/spain.html

python generar.py extraer --zona cataluna --pbf datos/cataluna-latest.osm.pbf
python generar.py generar --zona cataluna --contacto tu@correo.com