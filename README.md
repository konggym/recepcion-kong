# Kong Gym · Administración

App web (PWA) para el dueño y recepción de Kong Gym, conectada al Google Sheet `KongGym_Control_de_Pagos`.

- `index.html`: la app completa (Inicio, Socios, Cobros, Asistencia, Tienda)
- `google-sheets/KongGym_Admin.gs`: script que se pega en el Apps Script del Sheet; lee y registra datos solo en las columnas de captura
- `manifest.webmanifest` + `icons/`: permite instalarla en la pantalla de inicio
- `sw.js`: abre sin internet y se actualiza sola
- `?demo=1`: modo demo con datos de ejemplo (PIN dueño 000000 · recepción 111111); no toca el Sheet

Se publica con Cloudflare Workers: cada cambio que se sube a `main` se publica solo.
